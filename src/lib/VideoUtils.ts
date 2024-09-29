import axios from 'axios';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { voices } from './constants';
import { formatTime } from './utils';
import { AlignmentType } from './types';

ffmpeg.setFfmpegPath(ffmpegStatic!);
ffmpeg.setFfprobePath(ffprobeStatic.path);

export async function merge(urls: string[], tempDir: string, aspectRatio: string): Promise<string> {
    try {
        const inputFiles = await Promise.all(urls.map((url, index) => downloadVideo(url, tempDir, index)));
        console.log('Downloaded input files:', inputFiles);

        const outputPath = path.join(tempDir, 'merged_output.mp4');
        const scale = aspectRatio === "16:9" ? "scale=1920:1080" : "scale=1080:1920";

        // Create a temporary file to store the list of input files
        const listFilePath = path.join(tempDir, 'input_list.txt');
        const fileList = inputFiles.map(file => `file '${file}'`).join('\n');
        await fs.promises.writeFile(listFilePath, fileList);

        return new Promise((resolve, reject) => {
            const command = ffmpeg();

            command.input(listFilePath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions([
                    '-c:v libx264',
                    '-preset ultrafast',
                    '-crf 23',
                    '-vf', `${scale},format=yuv420p`,
                ])
                .output(outputPath)
                .on('start', (commandLine) => {
                    console.log('FFmpeg command:', commandLine);
                })
                .on('error', (err, stdout, stderr) => {
                    console.error('FFmpeg error:', err.message);
                    console.error('FFmpeg stdout:', stdout);
                    console.error('FFmpeg stderr:', stderr);
                    cleanupTempFiles([...inputFiles, listFilePath]);
                    reject(err);
                })
                .on('end', () => {
                    console.log('FFmpeg processing finished');
                    resolve(outputPath);
                    cleanupTempFiles([...inputFiles, listFilePath]);
                })
                .run();
        });
    } catch (error) {
        console.error('Error in merge function:', error);
        throw error;
    }
}

export async function generateStory(text: string, VideoStartText: string, VideoEndText: string): Promise<string> {
    try {
        const modelId = process.env.GENERATE_STORY_MODAL_ID;
        const url = `${process.env.GENERATE_STORY_URL}${modelId}`;
        const headers = {
            Authorization: `Bearer ${process.env.GENERATE_STORY_API_KEY}`,
            "Content-Type": "text/plain",
        };

        const prompt = `generate a short story like 200 characters from ${text} and let the story start with ${VideoStartText} and end with ${VideoEndText} and it should be in one part`;

        const response = await axios({
            method: 'post',
            url,
            headers: headers,
            data: { prompt },
        });

        if (response.data && response.data.result && response.data.result.response) {
            const storyText = response.data.result.response;
            console.log(storyText);
            return storyText;
        } else {
            console.error('Unexpected response structure:', response.data);
            throw new Error('Unexpected response structure');
        }

    } catch (error) {
        console.error('Error in generate story:', error);
        throw error;
    }
}

function downloadVideo(url: string, tempDir: string, index: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const filePath = path.join(tempDir, `input_${index}.mp4`);
        const file = fs.createWriteStream(filePath);

        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(filePath);
            });
        }).on('error', (err) => {
            fs.unlink(filePath, () => reject(err));
        });
    });
}

export async function cleanupTempFiles(files: string[]) {
    const deletionPromises = files.map(file =>
        fs.promises.unlink(file).catch(err => console.error(`Error deleting temporary file ${file}:`, err))
    );
    await Promise.allSettled(deletionPromises);
}

export async function textToAudio(text: string, tempDir: string, voiceName: string, subtitles: boolean): Promise<{ audioPath: string; subtitlePath: string }> {
    const voiceId = voices.find(voice => voice.name === voiceName)?.voiceId;
    if (!voiceId) {
        throw new Error(`Voice ID not found for voice name: ${voiceName}`);
    }

    try {
        const headers = {
            "xi-api-key": `${process.env.TEXT_TO_AUDIO_API_KEY}`,
        };
        const data = {
            text,
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0,
            use_speaker_boost: true
        };
        console.log('Sending request to Eleven Labs API...');
        const response = await axios({
            method: 'post',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
            headers: headers,
            data: data,
            responseType: 'json',
        });

        const { audio_base64, alignment } = response.data;
        const audioBuffer = Buffer.from(audio_base64, 'base64');
        const audioFileName = `audio_${Date.now()}.wav`;
        const audioPath = path.join(tempDir, audioFileName);

        console.log('Writing audio to file...');
        await fs.promises.writeFile(audioPath, audioBuffer);

        const subtitleFileName = `subtitles_${Date.now()}.srt`;
        const subtitlePath = path.join(tempDir, subtitleFileName);
        if (subtitles) {
            await generateSubtitles(text, alignment, subtitlePath);
        }
        return { audioPath, subtitlePath };
    } catch (error) {
        console.error('Error in textToAudio function:', error);
        throw error;
    }
}

async function generateSubtitles(text: string, alignment: AlignmentType, outputPath: string): Promise<void> {
    const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;

    let subtitleContent = '';
    let index = 0;
    let wordStartIndex = 0;

    while (index < characters.length) {
        const currentChar = characters[index];
        const startTime = character_start_times_seconds[wordStartIndex];
        const endTime = character_end_times_seconds[index];

        // Collect characters until a space or the end of the text
        if (currentChar === ' ' || index === characters.length - 1) {
            const word = text.substring(wordStartIndex, index + 1).trim();
            if (word.length > 0) {
                // Generate subtitle for the collected word
                subtitleContent += `${Math.floor(index / 3) + 1}\n`;
                subtitleContent += `${formatTime(startTime)} --> ${formatTime(endTime)}\n`;
                subtitleContent += `${word}\n\n`;
            }
            // Move to the next word
            wordStartIndex = index + 1;
        }

        index++;
    }

    await fs.promises.writeFile(outputPath, subtitleContent);
}

export function addSubtitles(videoPath: string, subtitlePath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // Escape the subtitle path
        const escapedSubtitlePath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
        const subtitleStyle = "FontName=DejaVu Sans,FontSize=20,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,BackColour=&H80000000,Bold=1,Alignment=2";

        console.log(`Adding subtitles: video=${videoPath}, subtitles=${subtitlePath}, output=${outputPath}`);

        ffmpeg(videoPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
                `-vf subtitles='${escapedSubtitlePath}':force_style='${subtitleStyle}'`,
            ])
            .on('start', (commandLine) => {
                console.log('FFmpeg command:', commandLine);
                console.log('Adding subtitles to video...');
            })
            .on('stderr', (stderrLine) => {
                console.log('FFmpeg stderr:', stderrLine);
            })
            .on('error', (err, stdout, stderr) => {
                console.error('FFmpeg error:', err.message);
                console.error('FFmpeg stdout:', stdout);
                console.error('FFmpeg stderr:', stderr);
                console.error('Failed to add subtitles to video');
                reject(err);
            })
            .on('end', () => {
                console.log('Subtitles added successfully');
                resolve();
            })
            .save(outputPath);
    });
}

export function addAudioToVideo(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .input(audioPath)
            .outputOptions([
                '-c:v copy',
                '-c:a aac',
                '-map 0:v:0',
                '-map 1:a:0',
                '-shortest'
            ])
            .on('start', (command) => {
                console.log('FFmpeg command (addAudioToVideo):', command);
            })
            .on('error', (err) => {
                console.error('FFmpeg error (addAudioToVideo):', err);
                reject(err);
            })
            .on('end', () => {
                console.log('Audio added to video successfully');
                resolve();
            })
            .save(outputPath);
    });
}

export function getFileDuration(audioPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(audioPath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                const duration = metadata.format.duration;
                resolve(duration || 60);
            }
        });
    });
}
