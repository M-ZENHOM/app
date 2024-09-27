import { Channel, ConsumeMessage } from 'amqplib';
import { Worker } from 'worker_threads';
import os from 'os';
import { connectRabbitMQ, VideoJob } from './lib/rabbitMQUtils';

const QUEUE_NAME = 'video-processing';

// Extend the Worker class to include isProcessing property
class CustomWorker extends Worker {
    isProcessing: boolean = false;
}

async function startConsumer() {
    let channel: Channel;

    try {
        channel = await connectRabbitMQ();

        // Create a pool of workers using CustomWorker
        const numCPUs = os.cpus().length;
        const workerPool = new Array(numCPUs).fill(null).map(() => new CustomWorker('./dist/videoProcessingWorker.js'));

        await channel.consume(QUEUE_NAME, async (msg: ConsumeMessage | null) => {
            if (msg !== null) {
                const job: VideoJob = JSON.parse(msg.content.toString());
                try {
                    // Find an available worker
                    const availableWorker = workerPool.find(worker => !worker.isProcessing);
                    if (availableWorker) {
                        availableWorker.isProcessing = true;
                        availableWorker.postMessage(job);
                        availableWorker.once('message', (result) => {
                            availableWorker.isProcessing = false;
                            channel.ack(msg);
                        });
                    } else {
                        // If no worker is available, nack the message to process it later
                        channel.nack(msg, false, true);
                    }
                } catch (error) {
                    console.error('Error processing job:', error);
                    channel.nack(msg, false, false);
                }
            }
        });

        console.log('Consumer started and waiting for messages');
    } catch (error) {
        console.error('Error starting consumer:', error);
        process.exit(1);
    }
}

startConsumer();