import { Channel, ConsumeMessage } from 'amqplib';
import { cpus } from 'os';
import { connectRabbitMQ, updateJobStatus } from './lib/rabbitMQUtils';
import { processImageJob } from './lib/ImagesUtils';
import { ImageJob } from './lib/types';

const QUEUE_NAME = 'video-processing';
const MAX_CONCURRENT_JOBS = Math.max(2, cpus().length - 1);
const activeJobs = new Set();

async function startConsumer() {
    try {
        console.log('Attempting to connect to RabbitMQ...');
        const channel = await connectRabbitMQ();
        console.log('Successfully connected to RabbitMQ');

        // Create multiple consumers
        for (let i = 0; i < MAX_CONCURRENT_JOBS; i++) {
            createConsumer(channel, i);
        }

        console.log(`Started ${MAX_CONCURRENT_JOBS} consumers`);

        process.on('SIGTERM', async () => {
            console.log('SIGTERM signal received: closing consumers');
            await channel.close();
            process.exit(0);
        });
    } catch (error) {
        console.error('Error starting consumer:', error);
        process.exit(1);
    }
}

function createConsumer(channel: Channel, workerId: number) {
    channel.consume(QUEUE_NAME, async (msg: ConsumeMessage | null) => {
        if (msg === null) return;

        const job = JSON.parse(msg.content.toString());
        const jobId = job.id;

        if (activeJobs.has(jobId)) {
            channel.nack(msg, false, true);
            return;
        }

        try {
            activeJobs.add(jobId);
            console.log(`Worker ${workerId} processing job ${jobId}`);
            // Update job status to 'processing' before starting
            await updateJobStatus(job.id, 'processing', 0);
            const result = await processImageJob(job);
            await updateJobStatus(job.id, 'completed', 100, result);
            channel.ack(msg);
            console.log(`Worker ${workerId} completed job ${jobId}`);
        } catch (error) {
            console.error(`Worker ${workerId} failed job ${jobId}:`, error);
            await updateJobStatus(jobId, 'failed', 0);
            channel.nack(msg, false, false);
        } finally {
            activeJobs.delete(jobId);
        }
    });
}

// Start the consumer
startConsumer().catch(console.error);