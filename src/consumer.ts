import { Channel, ConsumeMessage } from 'amqplib';
import { Worker } from 'worker_threads';
import os from 'os';
import { connectRabbitMQ, VideoJob, updateJobStatus } from './lib/rabbitMQUtils';
import { backOff } from "exponential-backoff";

const QUEUE_NAME = 'video-processing';
const JOB_TIMEOUT = 30 * 60 * 1000; // 30 minutes

class CustomWorker extends Worker {
    isProcessing: boolean = false;
}

async function startConsumer() {
    let channel: Channel;

    try {
        console.log('Attempting to connect to RabbitMQ...');
        channel = await connectRabbitMQ();
        console.log('Successfully connected to RabbitMQ');

        const numCPUs = os.cpus().length;
        await channel.prefetch(numCPUs);
        const workerPool = new Array(numCPUs).fill(null).map(() => new CustomWorker('./dist/videoProcessingWorker.js'));

        workerPool.forEach(worker => {
            worker.on('error', (error) => {
                console.error(`Worker error: ${error}`);
                worker.isProcessing = false;
            });
        });

        await channel.consume(QUEUE_NAME, async (msg: ConsumeMessage | null) => {
            if (msg !== null) {
                const job: VideoJob = JSON.parse(msg.content.toString());
                try {
                    await processJob(job, channel, msg, workerPool);
                } catch (error) {
                    console.error('Error processing job:', error);
                    channel.nack(msg, false, false);
                    await updateJobStatus(job.id, 'failed', 0);
                }
            }
        });

        console.log('Consumer started and waiting for messages');

        process.on('SIGTERM', async () => {
            console.log('SIGTERM signal received: closing consumer');
            await channel.close();
            process.exit(0);
        });
    } catch (error) {
        console.error('Error starting consumer:', error);
        process.exit(1);
    }
}

async function processJob(job: VideoJob, channel: Channel, msg: ConsumeMessage, workerPool: CustomWorker[]) {
    const processWithRetry = async () => {
        const availableWorker = workerPool.find(worker => !worker.isProcessing);
        if (availableWorker) {
            availableWorker.isProcessing = true;
            await updateJobStatus(job.id, 'processing', 0);

            return new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    availableWorker.isProcessing = false;
                    reject(new Error(`Job ${job.id} timed out`));
                }, JOB_TIMEOUT);

                availableWorker.postMessage(job);

                availableWorker.once('message', (result) => {
                    clearTimeout(timeoutId);
                    availableWorker.isProcessing = false;
                    resolve(result);
                });
            });
        } else {
            throw new Error('No available worker');
        }
    };

    try {
        const result = await backOff(() => processWithRetry(), {
            numOfAttempts: 3,
            startingDelay: 1000,
            timeMultiple: 2,
        });

        await updateJobStatus(job.id, 'completed', 100, result);
        channel.ack(msg);
    } catch (error) {
        console.error(`Job ${job.id} failed after retries:`, error);
        await updateJobStatus(job.id, 'failed', 0);
        channel.nack(msg, false, false);
    }
}

startConsumer();