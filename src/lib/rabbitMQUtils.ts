import amqp, { Channel, Connection } from 'amqplib';
import { supabase } from '../db';
import { backOff } from "exponential-backoff";

export interface VideoJob {
    id: string;
    data: {
        sessionId: string;
        urls: string[];
        text: string;
        voiceId: string;
        isHasScript: boolean;
        VideoStart: string;
        VideoEnd: string;
        subtitles: boolean;
        voiceOver: boolean;
        aspectRatio: string;
    };
    status: 'queued' | 'processing' | 'completed' | 'failed';
    progress: number;
    result?: any;
    startTime?: number;
}

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

const QUEUE_NAME = 'video-processing';

export async function connectRabbitMQ(): Promise<Channel> {
    const connect = async () => {
        const connection: Connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
        const channel: Channel = await connection.createChannel();
        await channel.assertQueue(QUEUE_NAME, { durable: true });
        console.log('Connected to RabbitMQ');

        connection.on('error', (err) => {
            console.error('RabbitMQ connection error:', err);
            throw err;
        });

        return channel;
    };

    return backOff(connect, {
        numOfAttempts: 5,
        startingDelay: 1000,
        timeMultiple: 2,
    });
}

export async function updateJobStatus(jobId: string, status: VideoJob['status'], progress: number, result: any = null) {
    const { error } = await supabase
        .from('video_status')
        .upsert({ video_id: jobId, status, progress, result })

    if (error) {
        console.error('Error updating video status:', error);
        throw error;
    }
}

export async function getJobStatus(jobId: string): Promise<VideoJob | null> {
    const { data, error } = await supabase
        .from('video_status')
        .select('*')
        .eq('video_id', jobId)
        .single()

    if (error) {
        console.error('Error fetching video status:', error);
        return null;
    }

    return data as VideoJob | null;
}

export async function purgeQueue(channel: Channel) {
    await channel.purgeQueue(QUEUE_NAME);
}

export async function getQueueMessageCount(channel: Channel): Promise<number> {
    const { messageCount } = await channel.assertQueue(QUEUE_NAME, { durable: true });
    return messageCount;
}