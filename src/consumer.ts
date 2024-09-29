import { Channel, ConsumeMessage } from 'amqplib';
import { Worker } from 'worker_threads';
import { connectRabbitMQ, updateJobStatus, VideoJob } from './lib/rabbitMQUtils';
import { processVideoJob } from './processVideoJob';

const QUEUE_NAME = 'video-processing';

class CustomWorker extends Worker {
    isProcessing: boolean = false;
}

async function startConsumer() {
    let channel: Channel;

    try {
        console.log('Attempting to connect to RabbitMQ...');
        channel = await connectRabbitMQ();
        console.log('Successfully connected to RabbitMQ');

        await channel.prefetch(1);

        await channel.consume(QUEUE_NAME, async (msg: ConsumeMessage | null) => {
            if (msg !== null) {
                const job: VideoJob = JSON.parse(msg.content.toString());
                try {
                    await processJob(job, channel, msg);
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

async function processJob(job: VideoJob, channel: Channel, msg: ConsumeMessage) {
    try {
        // Update job status to 'processing' before starting
        await updateJobStatus(job.id, 'processing', 0);
        
        const result = await processVideoJob(job);
        await updateJobStatus(job.id, 'completed', 100, result);
        channel.ack(msg);
    } catch (error) {
        console.error(`Job ${job.id} failed:`, error);
        await updateJobStatus(job.id, 'failed', 0);
        channel.nack(msg, false, false);
    }
}

startConsumer();