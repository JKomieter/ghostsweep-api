// src/index.ts
import express from 'express';
import dotenv from 'dotenv';
import { processNextJob, startWorker } from './worker';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// Manual trigger (for testing)
app.post('/trigger-worker', async (req, res) => {
    try {
        const processed = await processNextJob();
        res.json({
            message: processed ? 'Job processed' : 'No jobs pending'
        });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`);
    startWorker();
});

export default app;