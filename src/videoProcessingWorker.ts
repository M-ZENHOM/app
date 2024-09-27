import { parentPort } from 'worker_threads';
import { VideoJob } from './lib/rabbitMQUtils';
import { processVideoJob } from './processVideoJob';

parentPort?.on('message', async (job: VideoJob) => {
    try {
        const result = await processVideoJob(job);
        parentPort?.postMessage(result);
    } catch (error) {
        console.error('Error in video processing worker:', error as Error);
        parentPort?.postMessage({ error: (error as Error).message });
    }
});