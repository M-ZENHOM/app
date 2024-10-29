import axios from 'axios';
import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { supabase } from '../db';
import { updateJobStatus } from './rabbitMQUtils';
import { cleanupTempFiles } from './VideoUtils';
import { ImageData, ImageJob, Subtitle } from './types';

ffmpeg.setFfmpegPath(ffmpegStatic!);

export async function processImageJob(job: ImageJob) {
    const { sessionId, imagesList, audioFileUrl, subtitles } = job.data;
    const tempDir = path.join(__dirname, '..', 'temp', sessionId);
    await fs.mkdir(tempDir, { recursive: true });

    const tempFiles: string[] = [];
    const timings: { [key: string]: number } = {};
    const startTime = Date.now();

    try {
        await updateJobStatus(job.id, 'processing', 10);

        // Download images and audio concurrently
        const downloadStartTime = Date.now();
        const [downloadedImages, audioPath] = await Promise.all([
            downloadImages(imagesList, tempDir),
            downloadAudio(audioFileUrl, tempDir)
        ]);
        timings['downloads'] = Date.now() - downloadStartTime;
        tempFiles.push(...downloadedImages, audioPath);

        await updateJobStatus(job.id, 'processing', 30);

        // Generate subtitle file
        const subtitlePath = path.join(tempDir, 'subtitles.ass');
        await generateAssFile(subtitles, subtitlePath);
        tempFiles.push(subtitlePath);

        await updateJobStatus(job.id, 'processing', 50);

        // Create video from images with correct duration
        const videoStartTime = Date.now();
        const intermediateVideoPath = path.join(tempDir, 'intermediate.mp4');
        await createVideoFromImages(downloadedImages as unknown as ImageData[], intermediateVideoPath, subtitles);
        timings['videoCreation'] = Date.now() - videoStartTime;
        tempFiles.push(intermediateVideoPath);

        await updateJobStatus(job.id, 'processing', 70);

        // Add audio and subtitles
        const finalProcessingStartTime = Date.now();
        const finalVideoPath = path.join(tempDir, 'final.mp4');
        await addAudioAndSubtitles(intermediateVideoPath, audioPath, subtitlePath, finalVideoPath);
        timings['finalProcessing'] = Date.now() - finalProcessingStartTime;
        tempFiles.push(finalVideoPath);

        await updateJobStatus(job.id, 'processing', 90);

        // Upload to Supabase
        const uploadStartTime = Date.now();
        const fileBuffer = await fs.readFile(finalVideoPath);
        const uniqueFileName = `${Date.now()}-${sessionId}-final-video.mp4`;

        const { data, error } = await supabase
            .storage
            .from('videos')
            .upload(uniqueFileName, fileBuffer, {
                contentType: 'video/mp4',
            });

        if (error) {
            throw new Error(`Supabase upload error: ${error.message}`);
        }

        timings['supabaseUpload'] = Date.now() - uploadStartTime;
        timings['total'] = Date.now() - startTime;

        await updateJobStatus(job.id, 'completed', 100, { ...data, processingTime: timings['total'], timings });

        return { ...data, processingTime: timings['total'], timings };
    } catch (error) {
        console.error('Error processing image job:', error);
        await updateJobStatus(job.id, 'failed', 0, null);
        throw error;
    } finally {
        await cleanupTempFiles(tempFiles);
        await fs.rm(tempDir, { recursive: true, force: true }).catch(err =>
            console.error(`Error deleting temporary directory ${tempDir}:`, err)
        );
    }
}
async function downloadImages(imagesList: ImageJob['data']['imagesList'], tempDir: string): Promise<string[]> {
    return Promise.all(imagesList.map(async (image, index) => {
        const response = await axios.get(
            `https://hyzgqhhzdudntmbczpun.supabase.co/storage/v1/object/public/ai-images/${image.path}`,
            { responseType: 'arraybuffer' }
        );
        const imagePath = path.join(tempDir, `image_${index}.png`);
        await fs.writeFile(imagePath, response.data);
        return imagePath;
    }));
}
async function downloadAudio(audioUrl: string, tempDir: string): Promise<string> {
    const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const audioPath = path.join(tempDir, 'audio.mp3');
    await fs.writeFile(audioPath, response.data);
    return audioPath;
}
function createVideoFromImages(imagePaths: string[] | ImageData[], outputPath: string, transcript: ImageJob['data']['subtitles']): Promise<void> {
    return new Promise((resolve, reject) => {
        const normalizedPaths = imagePaths.map(image => {
            if (typeof image === 'string') {
                return { fullPath: image };
            }
            if (typeof image === 'object' && image.fullPath) {
                return image;
            }
            if (typeof image === 'object' && typeof (image as unknown as string) === 'string') {
                return { fullPath: image as unknown as string };
            }
            return { fullPath: String(image) };
        });

        const command = ffmpeg();
        const options = {
            width: 1080,
            height: 1920,
            transitionDuration: 1,
            fps: 30,
            defaultImageDuration: 5, // Default duration for each image in seconds
        };

        // Calculate durations with fallback
        let totalDuration: number;
        if (transcript && transcript.length > 0) {
            const maxEnd = Math.max(...transcript.map(sub => sub.end));
            totalDuration = Number.isFinite(maxEnd) ? maxEnd / 1000 : options.defaultImageDuration * normalizedPaths.length;
        } else {
            totalDuration = options.defaultImageDuration * normalizedPaths.length;
        }

        const durationPerImage = totalDuration / normalizedPaths.length;

        console.log('Processing configuration:', {
            totalDuration,
            durationPerImage,
            numberOfImages: normalizedPaths.length,
            options,
            aspectRatio: '9:16'
        });

        try {
            // Add inputs with duration
            normalizedPaths.forEach((image, index) => {
                console.log(`Processing image ${index + 1}/${normalizedPaths.length}:`, image.fullPath);
                command.input(image.fullPath)
                    .inputOptions([
                        '-loop', '1',
                        '-t', String(durationPerImage + options.transitionDuration) // Ensure we convert to string
                    ]);
            });

            // Build filter complex string properly
            const filterComplexParts: string[] = [];

            // Scale and crop images to vertical format
            normalizedPaths.forEach((_, i) => {
                filterComplexParts.push(
                    `[${i}:v]scale=${options.width}:${options.height}:force_original_aspect_ratio=increase,` +
                    `crop=${options.width}:${options.height}:(iw-ow)/2:(ih-oh)/2[scaled${i}]`
                );
            });

            // Chain transitions
            let lastOutput = 'scaled0';
            for (let i = 1; i < normalizedPaths.length; i++) {
                const currentInput = `scaled${i}`;
                const currentOutput = i === normalizedPaths.length - 1 ? 'output' : `trans${i}`;
                const offset = (i * durationPerImage) - options.transitionDuration;

                filterComplexParts.push(
                    `[${lastOutput}][${currentInput}]xfade=transition=fade:duration=${options.transitionDuration}:` +
                    `offset=${offset}[${currentOutput}]`
                );

                lastOutput = currentOutput;
            }

            const filterComplex = filterComplexParts.join(';');
            const finalOutput = normalizedPaths.length === 1 ? '[scaled0]' : '[output]';

            command
                .complexFilter(filterComplex, [finalOutput])
                .outputOptions([
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart',
                    '-b:v', '2.5M',
                    '-maxrate', '2.5M',
                    '-bufsize', '5M',
                    '-profile:v', 'main',
                    '-level', '4.0'
                ])
                .on('start', cmd => {
                    console.log('FFmpeg command:', cmd);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log('Processing: ' + Math.round(progress.percent) + '% done');
                    }
                })
                .on('error', (err) => {
                    console.error('FFmpeg error:', err);
                    reject(err);
                })
                .on('end', () => {
                    console.log('Video processing completed successfully');
                    resolve();
                })
                .save(outputPath);

        } catch (error) {
            console.error('Error during video creation:', error);
            reject(error);
        }
    });
}
function formatText(text: string): string {
    const words = text.split(/\s+/);

    return words.map((word, index) => {
        const upperWord = word.toUpperCase();
        // Create bounce animation for each word
        const delay = index * 0.3; // Stagger the animations
        const animTags = `{\\t(${delay * 1000},${delay * 1000 + 500},\\fscx120\\fscy120)\\t(${delay * 1000 + 300},${delay * 1000 + 600},\\fscx100\\fscy100)}`;

        return `${animTags}${upperWord}`;
    }).join(' ');
}
function formatAssTime(ms: number): string {
    const totalSeconds = ms / 1000;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const centiseconds = Math.floor((totalSeconds % 1) * 100);

    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
}
async function generateFontSection(fontPath: string): Promise<string> {
    // Read the font file
    await fs.readFile(fontPath);
    const fontFileName = path.basename(fontPath);

    return `[Fonts]
fontname: ${fontFileName}
filename: ${fontFileName}`;
}
async function generateAssFile(
    subtitles: Subtitle[],
    outputPath: string,
    fontPath: string = 'public/TitanOne-Regular.ttf'
): Promise<void> {
    // Generate the fonts section
    const fontSection = await generateFontSection(fontPath);

    const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

${fontSection}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Titan One,76,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    const events = subtitles.map(item => {
        const start = formatAssTime(item.start);
        const end = formatAssTime(item.end);
        const formattedText = formatText(item.text.replace(/\r\n|\r|\n/g, ' ').trim() || ' ');
        return `Dialogue: 0,${start},${end},Default,,0,0,0,,${formattedText}`;
    }).join('\n');

    const assContent = header + events;
    await fs.writeFile(outputPath, assContent, 'utf8');

    // Copy font file to the same directory as the ASS file
    const fontDestPath = path.join(path.dirname(outputPath), path.basename(fontPath));
    await fs.copyFile(fontPath, fontDestPath);
}
async function addAudioAndSubtitles(
    videoPath: string,
    audioPath: string,
    subtitlePath: string,
    outputPath: string,
    fontDir: string = path.dirname(subtitlePath)
): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .input(audioPath)
            .outputOptions([
                '-c:v', 'libx264',
                '-preset', 'medium',
                '-c:a', 'aac',
                '-strict', 'experimental',
                '-ar', '44100',
                '-map', '0:v',
                '-map', '1:a',
                '-vf', `ass='${subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:')}':fontsdir='${fontDir.replace(/\\/g, '/').replace(/:/g, '\\:')}'`
            ])
            .on('start', cmd => console.log('FFmpeg command:', cmd))
            .on('progress', (progress) => {
                if (progress.percent) {
                    console.log('Processing: ' + Math.round(progress.percent) + '% done');
                }
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                reject(err);
            })
            .on('end', () => {
                console.log('Finished processing');
                resolve();
            })
            .save(outputPath);
    });
}