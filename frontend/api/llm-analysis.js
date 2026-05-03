import { routeLlmAnalysis } from '../server/llm-analysis.js';

export default async function handler(req, res) {
  await routeLlmAnalysis(req, res);
}
