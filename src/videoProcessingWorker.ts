import { parentPort, workerData } from 'worker_threads';
import { VideoJob } from './lib/rabbitMQUtils';
import { processVideoJob } from './processVideoJob';

parentPort?.on('message', async (job: VideoJob) => {
    try {
        const result = await processVideoJob(job);
        parentPort?.postMessage(result);
    } catch (error) {
        console.error('Error in video processing worker:', error);
        parentPort?.postMessage({ error: (error as Error).message, jobId: job.id });
    }
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception in worker:', error);
    parentPort?.postMessage({ error: error.message, type: 'uncaughtException' });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection in worker:', reason);
    parentPort?.postMessage({ error: String(reason), type: 'unhandledRejection' });
    process.exit(1);
});