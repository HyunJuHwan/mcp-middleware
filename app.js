import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const LLM_URL = "http://localhost:8000/generate";
const MCP_URL = "http://localhost:1337/mcp";

// 세션 ID 저장 변수
let sessionId = null;

// MCP 초기화 요청
async function initializeMcpSession() {
  try {
    const initRes = await axios.post(MCP_URL, {
      jsonrpc: "2.0",
      id: "init-001",
      method: "initialize",
      params: {
        protocolVersion: "1.0",
        capabilities: {},
        clientInfo: {
          name: "Middleware",
          version: "1.0"
        }
      }
    }, {
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      }
    });

    sessionId = initRes.headers["mcp-session-id"];
    console.log("[✅ MCP 세션 ID 획득]", sessionId);
  } catch (e) {
    console.error("[❌ MCP 초기화 실패]", e.response?.data || e.message);
    process.exit(1);
  }
}

const IMAGE_BASE_DIR = "/Users/soulx/Desktop/workspace/scenario-word/dist/tools/character";

// ✅ GET /image/:filename → 이미지 파일 서빙
app.get("/image/:filename", (req, res) => {
  const { filename } = req.params;
  const fullPath = path.join(IMAGE_BASE_DIR, filename);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).send("File not found");
  }

  res.sendFile(fullPath);
});

// LLM → MCP 중계 라우터
app.post("/route", async (req, res) => {
  const userPrompt = req.body.prompt;
  if (!userPrompt) return res.status(400).json({ error: "prompt is required" });

  try {
    // 1. LLM 호출
    const llmRes = await axios.post(LLM_URL, {
      messages: [{ role: "user", content: userPrompt }]
    });

    const { tool, input } = llmRes.data.output;
    if (!tool || !input) {
      return res.status(400).json({ error: "Invalid LLM response" });
    }

    // 2. MCP 호출 (JSON-RPC + 세션 헤더)
    const mcpRes = await axios.post(MCP_URL, {
      jsonrpc: "2.0",
      id: "req-001",
      method: "tools/call",
      params: {
        name: tool,
        arguments: input
      }
    }, {
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId
      }
    });

    console.log("[DEBUG] MCP 전체 응답:", JSON.stringify(mcpRes.data, null, 2));

    const results = mcpRes.data.map(entry => {
      const contents = entry.result?.content || [];
      const updatedContents = contents.map(item => {
        if (item.type === "text") {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed.image_url && parsed.image_url.endsWith(".png")) {
              const filename = path.basename(parsed.image_url);
              parsed.image_url = `http://221.142.31.32:8001/image/${filename}`;
            }
            item.text = JSON.stringify(parsed);
          } catch (e) {
            console.error("[JSON 파싱 실패]", item.text);
          }
        }
        return item;
      });
    
      return {
        ...entry,
        result: {
          ...entry.result,
          content: updatedContents
        }
      };
    });

    return res.json({ result: results });
  } catch (e) {
    console.error("[중계 서버 ERROR]", e.response?.data || e.message);
    return res.status(500).json({ error: e.message });
  }
});

// 서버 실행
const PORT = 8001;
app.listen(PORT, async () => {
  await initializeMcpSession();
  console.log(`🧠 중계 서버 http://localhost:${PORT} 실행됨`);
});