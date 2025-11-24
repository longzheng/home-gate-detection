import type sharp from 'sharp';

export async function saveCroppedImage(
    croppedImage: sharp.Sharp,
    folder: string,
) {
    const timestamp = new Date().toISOString().replace(/:/g, '_');
    const filePath = `images/${folder}/${timestamp}.jpg`;
    await croppedImage.toFormat('jpeg').toFile(filePath);
}
