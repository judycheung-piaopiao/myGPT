import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const chat = new ChatOpenAI({
  model: "gpt-3.5-turbo",
  streaming: true, // 开启流式输出
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/ask", async (req, res) => {
  const { question } = req.body;

  if (!question) {
    res.status(400).json({ error: "No question provided" });
    return;
  }

  // 设置 HTTP headers 支持流式传输
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await chat.stream([new HumanMessage(question)]);
    for await (const chunk of stream) {
      res.write(chunk.content);
    }
    
    res.end();

  } catch (err) {
    console.error(err);
    res.status(500).end("Error generating response");
    if (!res.headersSent) {
      res.status(500).json({ error: "Error generating response" });
    } else {
      // 如果已经开始流式传输，只能结束连接
      res.end();
    }
  }
});




app.listen(3001, () => {
  console.log("server running on http://localhost:3001");
});
