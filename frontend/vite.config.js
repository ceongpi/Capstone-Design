import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { routeLlmAnalysis } from './server/llm-analysis.js'

function llmAnalysisDevPlugin() {
  return {
    name: 'llm-analysis-dev-plugin',
    configureServer(server) {
      server.middlewares.use('/api/llm-analysis', async (req, res, next) => {
        if (req.url !== '/' && req.url !== '') {
          next()
          return
        }

        await routeLlmAnalysis(req, res)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')

  return {
    base: env.BASE_PATH || '/',
    plugins: [react(), llmAnalysisDevPlugin()],
  }
})
