import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

const LLM_URL = "http://localhost:8000/generate";
const MCP_URL = "http://localhost:1337/mcp";

// 세션 ID 저장
let sessionId = null;

// MCP 초기화
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

// 이미지 파일 서빙
const STATIC_BASE_DIR = "/Users/soulx/Desktop/workspace/scenario-word/dist/tools";
const ALLOWED_DIRS = ["character", "scene", "video", "webtoon"];

app.get("/image/:type/:filename", (req, res) => {
  const { type, filename } = req.params;
  if (!ALLOWED_DIRS.includes(type)) {
    return res.status(400).send("Invalid image category");
  }

  const fullPath = path.join(STATIC_BASE_DIR, type, filename);
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
    // LLM 호출
    const llmRes = await axios.post(LLM_URL, {
      messages: [{ role: "user", content: userPrompt }]
    });

    console.log("[DEBUG] LLM 응답:", JSON.stringify(llmRes.data, null, 2));

    let callList = llmRes.data.output;
    if (!Array.isArray(callList)) {
      if (typeof callList === "object" && callList.tool && callList.input) {
        callList = [callList];
      } else {
        return res.status(400).json({ error: "LLM output is not a valid tool call" });
      }
    }

    const allResults = [];
    const context = {};
    const aliasMap = {};

    for (let i = 0; i < callList.length; i++) {
      const { tool, input } = callList[i];

      // ID 치환
      if (input.character_ids) {
        input.character_ids = input.character_ids.map(id => aliasMap[id] || id);
      }
      if (input.scene_ids) {
        input.scene_ids = input.scene_ids.map(id => aliasMap[id] || id);
      }

      // MCP 툴 호출
      const mcpRes = await axios.post(MCP_URL, {
        jsonrpc: "2.0",
        id: `req-${i}`,
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

      const entries = mcpRes.data;
      const ids = [];

      for (const entry of entries) {
        const content = entry.result?.content || [];

        for (const item of content) {
          if (item.type === "text") {
            try {
              const parsed = JSON.parse(item.text);

              // ID 수집
              if (parsed.character_id) ids.push(parsed.character_id);
              if (parsed.scene_id) ids.push(parsed.scene_id);
              if (parsed.webtoon_id) ids.push(parsed.webtoon_id);

              // aliasMap 등록
              if (tool === "createCharacter") {
                aliasMap[`c-${context.characterCount ?? 1}`] = parsed.character_id;
                context.characterCount = (context.characterCount ?? 1) + 1;
              }
              if (tool === "createScene") {
                aliasMap[`s-${context.sceneCount ?? 1}`] = parsed.scene_id;
                context.sceneCount = (context.sceneCount ?? 1) + 1;
              }

              const possibleKeys = ["image_url", "webtoon_url", "video_url"];
              for (const key of possibleKeys) {
                if (parsed[key] && (parsed[key].endsWith(".png") || parsed[key].endsWith(".mp4"))) {
                  const segments = parsed[key].split("/");
                  const type = segments[segments.length - 2]; // character, scene, video, webtoon
                  const filename = segments[segments.length - 1];
                  parsed[key] = `http://221.142.31.32:8001/image/${type}/${filename}`;
                }
              }

              item.text = JSON.stringify(parsed);
            } catch (e) {
              console.error("[❌ JSON 파싱 실패]", item.text, e.message);
            }
          }
        }
      }

      // context 업데이트
      if (tool === "createCharacter") context.character_ids = ids;
      if (tool === "createScene") context.scene_ids = ids;

      allResults.push(...entries);
    }

    return res.json({ result: allResults });
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
