import amqp, { Channel, Connection } from 'amqplib';
import { backOff } from "exponential-backoff";
import { cpus } from 'os';
import { supabase } from '../db';

const QUEUE_NAME = 'video-processing';
const MAX_CONCURRENT_JOBS = Math.max(2, cpus().length - 1);


export interface NewVideoJob {
    id: string;
    data: {
        sessionId: string;
        audioFileUrl: string;
        subtitles: {
            transcript: {
                text: string,
                start: number,
                end: number,
                confidence: number,
            }[]
        },
        imagesList: {
            path: string,
            id: string,
            fullPath: string
        }[],
    }
    status: 'queued' | 'processing' | 'completed' | 'failed';
    progress: number;
    result?: any;
    startTime?: number;
}


async function deleteQueueIfExists(channel: Channel) {
    try {
        await channel.deleteQueue(QUEUE_NAME);
        console.log(`Deleted queue ${QUEUE_NAME} if it existed.`);
    } catch (error) {
        console.log(`Queue ${QUEUE_NAME} did not exist or could not be deleted.`);
    }
}

export async function connectRabbitMQ(): Promise<Channel> {
    const connect = async () => {
        try {
            const connection: Connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
            const channel: Channel = await connection.createChannel();
            await deleteQueueIfExists(channel);
            await channel.assertQueue(QUEUE_NAME, {
                durable: true,
                arguments: {
                    'x-max-priority': 10
                }
            });

            await channel.prefetch(1, false);

            console.log(`Connected to RabbitMQ with ${MAX_CONCURRENT_JOBS} concurrent processors`);
            return channel;
        } catch (error) {
            console.error('Failed to connect to RabbitMQ:', error);
            throw error;
        }
    };

    return backOff(connect, {
        numOfAttempts: 5,
        startingDelay: 1000,
        timeMultiple: 2,
    });
}

export async function updateJobStatus(jobId: string, status: NewVideoJob['status'], progress: number, result: any = null) {
    const { error } = await supabase
        .from('video_status')
        .upsert({ video_id: jobId, status, progress, result })

    if (error) {
        console.error('Error updating video status:', error);
        throw error;
    }
}

export async function getJobStatus(jobId: string): Promise<NewVideoJob | null> {
    const { data, error } = await supabase
        .from('video_status')
        .select('*')
        .eq('video_id', jobId)
        .single()

    if (error) {
        console.error('Error fetching video status:', error);
        return null;
    }

    return data as NewVideoJob | null;
}


export async function purgeQueue(channel: Channel) {
    await channel.purgeQueue(QUEUE_NAME);
}

export async function getQueueMessageCount(channel: Channel): Promise<number> {
    const { messageCount } = await channel.assertQueue(QUEUE_NAME, { durable: true });
    return messageCount;
}