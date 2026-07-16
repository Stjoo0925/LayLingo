import express from "express";
import OpenAI from "openai";
import { z } from "zod";

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(express.json({ limit: "64kb" }));

const translationRequest = z.object({
  text: z.string().trim().min(1).max(4_000),
  sourceLanguage: z.string().trim().min(2).max(16).default("auto"),
  targetLanguage: z.string().trim().min(2).max(16).default("ko"),
  nearbyText: z.string().trim().max(2_000).optional(),
});

const batchTranslationRequest = z.object({
  items: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    text: z.string().trim().min(1).max(4_000),
  })).min(1).max(100),
  sourceLanguage: z.string().trim().min(2).max(16).default("auto"),
  targetLanguage: z.string().trim().min(2).max(16).default("ko"),
});

const demoTranslations: Record<string, string> = {
  "product specifications": "제품 사양",
  "user manual": "사용 설명서",
  "important safety instructions": "중요 안전 지침",
  "table of contents": "목차",
  "introduction": "소개",
};

function demoTranslate(text: string) {
  return demoTranslations[text.trim().toLowerCase()] ?? `[데모 번역] ${text}`;
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, translationMode: process.env.OPENAI_API_KEY ? "openai" : "demo" });
});

app.post("/api/translate", async (request, response) => {
  const parsed = translationRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "번역 요청 형식이 올바르지 않습니다." });
    return;
  }

  const { text, sourceLanguage, targetLanguage, nearbyText } = parsed.data;

  if (!process.env.OPENAI_API_KEY) {
    response.json({ translatedText: demoTranslate(text), mode: "demo" });
    return;
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const result = await client.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5",
      instructions: "당신은 PDF 편집기용 전문 번역가입니다. 숫자, 단위, 제품명, URL, 변수와 입력의 줄바꿈 구조를 보존하고 번역문만 출력합니다.",
      input: `원문 언어: ${sourceLanguage}\n대상 언어: ${targetLanguage}\n주변 문맥: ${nearbyText ?? "없음"}\n번역할 문장: ${text}`,
    });

    const translatedText = result.output_text.trim();
    if (!translatedText) {
      throw new Error("번역 결과가 비어 있습니다.");
    }

    response.json({ translatedText, mode: "openai" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    response.status(502).json({ message: `번역 서비스 요청에 실패했습니다: ${message}` });
  }
});

app.post("/api/translate/batch", async (request, response) => {
  const parsed = batchTranslationRequest.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "묶음 번역 요청 형식이 올바르지 않습니다." });
    return;
  }

  const { items, sourceLanguage, targetLanguage } = parsed.data;
  if (!process.env.OPENAI_API_KEY) {
    response.json({
      translations: items.map((item) => ({ id: item.id, translatedText: demoTranslate(item.text) })),
      mode: "demo",
    });
    return;
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const result = await client.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5",
      instructions: [
        "당신은 PDF 편집기용 전문 번역가입니다.",
        "모든 항목은 같은 문서에서 선택되었으므로 전체 문맥을 공유해 번역합니다.",
        "각 id를 반드시 그대로 유지하고, 항목을 합치거나 나누지 마세요.",
        "숫자, 단위, 제품명, URL, 변수와 줄바꿈 구조를 보존하세요.",
        "출력은 translations 배열만 가진 JSON 객체이며 각 원소는 id와 translatedText를 가져야 합니다.",
      ].join("\n"),
      input: JSON.stringify({ sourceLanguage, targetLanguage, items }),
    });

    const normalized = result.output_text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
    const output = z.object({
      translations: z.array(z.object({ id: z.string(), translatedText: z.string().trim().min(1) })),
    }).parse(JSON.parse(normalized));
    const requestedIds = new Set(items.map((item) => item.id));
    response.json({
      translations: output.translations.filter((item) => requestedIds.has(item.id)),
      mode: "openai",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    response.status(502).json({ message: `묶음 번역 서비스 요청에 실패했습니다: ${message}` });
  }
});

app.listen(port, () => {
  console.log(`LayLingo API가 http://localhost:${port}에서 실행 중입니다.`);
});
