import { motion } from 'framer-motion'

// Placeholder screen for Step 1. The real forecast UI comes in a later step.
export default function App() {
  return (
    <div className="flex min-h-dvh flex-col bg-sky-950 text-sky-50">
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <motion.h1
          className="text-4xl font-bold tracking-tight"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          Surf App
        </motion.h1>
        <p className="max-w-xs text-sky-200">
          Self-learning surf forecast for Vilanova i la Geltrú. Coming soon.
        </p>
      </main>
      <footer className="p-4 text-center text-xs text-sky-300">
        <a href="https://open-meteo.com/" className="underline">
          Weather data by Open-Meteo.com
        </a>
      </footer>
    </div>
  )
}
