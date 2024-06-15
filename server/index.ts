import * as ort from "onnxruntime-node";
import sharp from "sharp";
import AxiosDigestAuth from "@mhoc/axios-digest-auth";
import axios from "axios";
import "dotenv/config";
import { readFile } from "fs/promises";

const digestAuth = new AxiosDigestAuth({
    username: process.env.CAMERA_USERNAME!,
    password: process.env.CAMERA_PASSWORD!,
});

void (async () => {
    const onnxModel = await readFile("best.onnx");

    for (;;) {
        try {
            const classification = await classifyGate({ onnxModel });
            logWithTimestamp(`classification: ${classification}`);

            await updateHomeAssistant(classification);
            logWithTimestamp(`updated home assistant`);
        } catch (error) {
            if (error instanceof Error) {
                logWithTimestamp(`exception: ${error.message}
${error.stack}`);
                continue;
            }

            throw error;
        }
    }
})();

async function classifyGate({ onnxModel }: { onnxModel: Buffer }) {
    // get image
    console.time("get_camera_image");
    const { croppedImage, croppedImageBuffer } = await get_camera_image();
    console.timeEnd("get_camera_image");

    // classify
    console.time("classify_image");
    const classify = await classify_image({
        img: croppedImageBuffer,
        onnxModel: onnxModel,
    });
    console.timeEnd("classify_image");

    // filter out low confidence
    const confidenceThreshold = 0.8;
    const filtered = classify.filter(
        (classification) => classification.confidence > confidenceThreshold
    );

    // sort by confidence result descending
    const result = filtered.sort((a, b) => b.confidence - a.confidence);

    if (result.length === 0) {
        throw new Error("no confident results");
    }

    const topResult = result[0];
    logWithTimestamp(`top result: ${JSON.stringify(topResult)}`);

    if (
        topResult.classification === "open" &&
        process.env.SAVE_OPEN_IMAGES === "true"
    ) {
        // save the image to disk
        await croppedImage
            .toFormat("jpeg")
            .toFile(
                `open-images/${new Date().toISOString().replace(/:/g, "_")}.jpg`
            );
    }

    return topResult.classification;
}

async function updateHomeAssistant(classification: ClassifyLabels) {
    await axios.post(
        process.env.HOME_ASSISTANT_URL!,
        {
            state: classification === "open" ? "on" : "off",
            attributes: {
                device_class: "garage_door",
                friendly_name: "Driveway gate",
            },
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.HOME_ASSISTANT_TOKEN}`,
                "content-type": "application/json",
            },
            timeout: 10_000,
        }
    );
}

async function get_camera_image() {
    const imageBuffer = await digestAuth
        .request({
            method: "GET",
            url: process.env.CAMERA_URL!,
            responseType: "arraybuffer",
            timeout: 10_000,
        })
        .then((response) => response.data);

    const sharpImage = sharp(imageBuffer, { failOn: "none" });

    // crop image to gate
    const croppedImage = sharpImage.extract({
        left: 2142,
        top: 333,
        width: 585,
        height: 468,
    });

    // crop image to gate
    const croppedImageBuffer = await croppedImage
        .clone()
        // classify model is hard-coded to 224x224
        .resize({ width: 224, height: 224, fit: "fill" })
        .raw()
        .toBuffer();

    return { croppedImageBuffer, croppedImage };
}

// helpers from https://github.com/AndreyGermanov/yolov8_onnx_nodejs/blob/main/object_detector.js
async function classify_image({
    img,
    onnxModel,
}: {
    img: Buffer;
    onnxModel: Buffer;
}) {
    const input = prepare_input(img);
    const output = await run_model({ input, onnxModel });

    const result = Object.entries(output).map(([key, value]) => {
        return { classification: labels[key], confidence: value as number };
    });

    logWithTimestamp(`model result: ${JSON.stringify(result)}`);

    return result;
}

/**
 * Function used to convert input image to tensor,
 * required as an input to YOLOv8 object detection
 * network.
 */
function prepare_input(pixels: Buffer) {
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
async function run_model({
    input,
    onnxModel,
}: {
    input: number[];
    onnxModel: Buffer;
}) {
    const model = await ort.InferenceSession.create(onnxModel);
    const tensor = new ort.Tensor(
        Float32Array.from(input),
        [
            1,
            // 3 channels?
            3,
            // width
            224,
            // height
            224,
        ]
    );
    const outputs = await model.run({ images: tensor });
    const data = outputs["output0"].data;

    return data;
}

type ClassifyLabels = "closed" | "open";

const labels: Record<string, ClassifyLabels> = {
    "0": "closed",
    "1": "open",
};

function logWithTimestamp(message: string) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}
