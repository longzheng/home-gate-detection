import express, { Request, Response } from "express";
// import ort from "onnxruntime-node";
const ort = require("onnxruntime-node");
import sharp from "sharp";
import AxiosDigestAuth from "@mhoc/axios-digest-auth";

import "dotenv/config";

const app = express();
const port = process.env.PORT || 3000;
app.get("/", async (req: Request, res: Response) => {
    res.json({ result: await classifyGate() });
});
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

async function classifyGate() {
    // get image
    const image = await get_camera_image();

    console.log("got camera image");

    // classify
    const classify = (await detect_objects_on_image(image)) as Record<
        ClassifyLabels,
        number
    >;

    const result = Object.entries(classify).sort((a, b) => b[1] - a[1]);

    return result[0][0];
}

const digestAuth = new AxiosDigestAuth({
    username: process.env.CAMERA_USERNAME!,
    password: process.env.CAMERA_PASSWORD!,
});

async function get_camera_image() {
    const imageBuffer = await digestAuth
        .request({
            method: "GET",
            url: process.env.CAMERA_URL!,
            responseType: "arraybuffer",
        })
        .then((response) => response.data);

    console.log("downloaded image");

    const sharpImage = await sharp(imageBuffer, { failOn: "none" });

    // crop image to gate
    const croppedImageBuffer = await sharpImage
        .extract({
            left: 2142,
            top: 333,
            width: 585,
            height: 468,
        })
        // classify model is hard-coded to 224x224
        .resize({ width: 224, height: 224, fit: "fill" })
        .raw()
        .toBuffer();

    return croppedImageBuffer;
}

// helpers from https://github.com/AndreyGermanov/yolov8_onnx_nodejs/blob/main/object_detector.js
/**
 * Function receives an image, passes it through YOLOv8 neural network
 * and returns an array of detected objects and their bounding boxes
 * @param buf Input image body
 * @returns Array of bounding boxes in format [[x1,y1,x2,y2,object_type,probability],..]
 */
async function detect_objects_on_image(img: Buffer) {
    const input = await prepare_input(img);
    const output = await run_model({ input });
    return output;
}

/**
 * Function used to convert input image to tensor,
 * required as an input to YOLOv8 object detection
 * network.
 */
async function prepare_input(pixels: Buffer) {
    const red: number[] = [],
        green: number[] = [],
        blue: number[] = [];
    for (let index = 0; index < pixels.length; index += 3) {
        red.push(pixels[index] / 255.0);
        green.push(pixels[index + 1] / 255.0);
        blue.push(pixels[index + 2] / 255.0);
    }
    const input = [...red, ...green, ...blue];
    return input;
}

/**
 * Function used to pass provided input tensor to YOLOv8 neural network and return result
 * @param input Input pixels array
 * @returns Raw output of neural network as a flat array of numbers
 */
async function run_model({ input }: { input: number[] }) {
    const model = await ort.InferenceSession.create("best.onnx");
    input = new ort.Tensor(Float32Array.from(input), [1, 3, 224, 224]);
    const outputs = await model.run({ images: input });
    const data = outputs["output0"].data as Record<string, number>;

    const result: Record<string, typeof data[keyof typeof data]> = {};

    for (const [key, value] of Object.entries(data)) {
            result[labels[key]] = value;
    }

    return result;
}

type ClassifyLabels = "closed" | "open";

const labels: Record<string, ClassifyLabels> = {
    "0": "closed",
    "1": "open",
};
