import AxiosDigestAuth from '@mhoc/axios-digest-auth';
import sharp from 'sharp';
import { getRequiredEnv, getRequiredNumberEnv } from './env.js';

const digestAuth = new AxiosDigestAuth.default({
    username: getRequiredEnv('CAMERA_USERNAME'),
    password: getRequiredEnv('CAMERA_PASSWORD'),
});

const cameraUrl = getRequiredEnv('CAMERA_URL');

const cropSettings = {
    left: getRequiredNumberEnv('CAMERA_CROP_LEFT'),
    top: getRequiredNumberEnv('CAMERA_CROP_TOP'),
    width: getRequiredNumberEnv('CAMERA_CROP_WIDTH'),
    height: getRequiredNumberEnv('CAMERA_CROP_HEIGHT'),
};

export async function getCameraImage() {
    const imageBuffer = await digestAuth
        .request({
            method: 'GET',
            url: cameraUrl,
            responseType: 'arraybuffer',
            timeout: 10_000,
        })
        .then((response) => response.data);

    return sharp(imageBuffer, { failOn: 'none' }).extract(cropSettings);
}
