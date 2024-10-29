export interface ErrorType {
    statusCode: number;
    statusText: string;
    message: string;
}

export type AlignmentType = {
    characters: string[],
    character_start_times_seconds: number[],
    character_end_times_seconds: number[],
}

export interface ImageItem {
    path: string;
    id: string;
    fullPath: string;
}
export interface ImageData {
    path: string;
    fullPath: string;
    id: string;
}

export interface Subtitle {
    start: number;
    end: number;
    text: string;
}

export interface NewVideoJob {
    id: string;
    data: {
        sessionId: string;
        subtitles: {
            transcript: Subtitle[];
        };
        audioFileUrl: string;
        imagesList: ImageItem[];
    };
}

export interface ImageJob {
    id: string;
    data: {
        sessionId: string;
        imagesList: Array<{
            path: string;
            id: string;
            fullPath: string;
        }>;
        audioFileUrl: string;
        subtitles: Array<{
            text: string;
            start: number;
            end: number;
            confidence: number;
            speaker: null;
        }>;

    };
    status: 'queued' | 'processing' | 'completed' | 'failed';
    progress: number;
    startTime: number;
}
