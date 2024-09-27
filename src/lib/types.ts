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