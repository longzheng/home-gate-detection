# home-gate-detection

Detect whether a driveway gate is open or closed from a CCTV snapshot, then publish its state to Home Assistant over MQTT.

The project uses an Ultralytics image classification model exported to ONNX and a TypeScript server running on Node.js. The current training notebook starts from `yolo26n-cls.pt`.

## Background

My swing gate has a FAAC EO24S controller and a Wi-Fi relay to trigger it, but the relay cannot report whether the gate is open or closed. Rather than adding a reed switch and wiring around the swing arms, I use an existing CCTV camera with an unobstructed view of the gate.

The original experiment used YOLOv8 and 87 pre-cropped images labelled with Roboflow, covering different lighting, weather, vehicles, and people. The current training workflow is described below.

![Sample of training images](https://github.com/longzheng/home-gate-detection/assets/484912/2435e1a2-046c-497f-937d-59c6efa9f60c)

## How it works

1. Fetch a camera snapshot using HTTP Digest authentication, with a 10-second request timeout.
2. Crop the configured gate region and resize the entire crop to 224 × 224 RGB pixels.
3. Run `best.onnx` with ONNX Runtime using float32 NCHW input scaled to `[0, 1]`.
4. Accept the highest-scoring class only when its confidence is **greater than 0.95**.
5. Confirm the gate state after two consecutive matching confident readings and publish it over MQTT.

The loop runs continuously, with a one-second delay after errors. There is no fixed polling interval. The server reports state only; gate control remains with the existing relay and Home Assistant.

## Run the server

Use Node.js 24 (matching the Docker image) and pnpm, or use Docker Compose.

Before starting:

- Provide a camera snapshot URL and Digest authentication credentials.
- Train or supply a compatible model and place it at `server/best.onnx`. Model weights and training images are not included in Git.
- Set the crop coordinates to match your camera and training images.
- For Home Assistant integration, provide an MQTT broker reachable by both the server and Home Assistant.

From the repository root, run these PowerShell commands:

```powershell
cd server
Copy-Item .env.example .env
New-Item -ItemType Directory -Force images/open, images/closed, images/not-confident
pnpm install --frozen-lockfile
```

Edit `.env` using the settings below, then start the server:

```powershell
pnpm build
pnpm start
```

For development, use `pnpm dev` to run the TypeScript source directly. Run commands from `server/`: the model, `.env`, and image paths are relative to the working directory.

### Configuration

| Variable | Required / default | Purpose |
| --- | --- | --- |
| `CAMERA_URL` | Required | URL returning a camera snapshot. |
| `CAMERA_USERNAME` | Required | Camera Digest authentication username. |
| `CAMERA_PASSWORD` | Required | Camera Digest authentication password. |
| `CAMERA_CROP_LEFT` | Required | Left edge of the gate crop, in source-image pixels. |
| `CAMERA_CROP_TOP` | Required | Top edge of the gate crop, in source-image pixels. |
| `CAMERA_CROP_WIDTH` | Required | Width of the gate crop, in pixels. |
| `CAMERA_CROP_HEIGHT` | Required | Height of the gate crop, in pixels. |
| `MQTT_HOST` | Optional | Broker host, optionally with a port, e.g. `192.168.1.10:1883`. The server prepends `mqtt://`; leave blank to run without MQTT. |
| `SAVE_OPEN_IMAGES` | `false` | Save every confident open crop. |
| `SAVE_CLOSED_IMAGES` | `false` | Save a random 1% sample of confident closed crops. |
| `DEBOUNCE_MAX_GAP_MS` | `5000` | Maximum gap between capture start times for matching readings to count toward confirmation. |
| `STALE_STATE_TIMEOUT_MS` | `30000` | Expire the confirmed state when its supporting capture is this old. |

The crop values in `.env.example` are specific to my camera. Use a rectangle within your snapshot bounds. Both timeout settings must be positive finite numbers. Image-saving flags accept `true` or `false` (case-insensitive).

Crops with no confident result are always saved to `images/not-confident/`, regardless of the flags. Other saved crops go to `images/open/` and `images/closed/`. The server does not create these directories or prune old images, so create them before starting and manage disk usage as needed.

### Docker Compose

After preparing `.env`, `best.onnx`, and the image directories in `server/`, run from that directory:

```sh
docker compose up -d --build
docker compose logs -f
```

Compose builds the Node.js 24 image, loads `.env`, mounts `best.onnx` and `images/`, and restarts the service automatically. The container runs as the `node` user, which needs write access to the mounted image directories. Use a broker address reachable from the container; `localhost` refers to the container itself.

## Home Assistant

Enable Home Assistant's MQTT integration against the same broker. The server publishes retained discovery configuration for a binary sensor named **Driveway Gate**, with the unique ID `home_gate_detection_driveway_gate` and device class `garage_door`. No Home Assistant HTTP URL or access token is used.

All topics share the prefix `homeassistant/binary_sensor/home_gate_detection_driveway_gate`:

| Topic suffix | Payload |
| --- | --- |
| `/config` | Home Assistant discovery JSON. |
| `/state` | `on` for open, `off` for closed. |
| `/availability` | `online` or `offline`. |

State and availability publications are retained, use QoS 1, and are retried after publication failures. Reconnecting republishes discovery and the current state/availability. A retained MQTT last will marks the sensor offline when the broker detects an unexpected disconnect.

### Confirmation and availability

The sensor starts unavailable. It needs two consecutive confident matching readings, no more than `DEBOUNCE_MAX_GAP_MS` apart, to become available or change state. Camera/inference errors and uncertain frames reset pending confirmation.

The last confirmed state remains available until `STALE_STATE_TIMEOUT_MS` has elapsed since its supporting capture. Alternating predictions do not refresh it, and results already that old are discarded. A watchdog checks expiry every 250 ms, including while capture or inference is awaiting I/O. After expiry, two matching readings are required to recover.

### Combine the sensor with a gate relay

A [Home Assistant template cover](https://www.home-assistant.io/integrations/template/#cover) can combine the detected state with an existing relay. Replace the entity IDs below with your actual MQTT sensor and relay entities. This example assumes the relay is already configured to pulse the gate controller for open, close, and stop.

```yaml
template:
  - cover:
      - name: "Driveway gate"
        device_class: gate
        state: "{{ is_state('binary_sensor.driveway_gate', 'on') }}"
        availability: "{{ states('binary_sensor.driveway_gate') in ['on', 'off'] }}"
        open_cover:
          - action: switch.turn_on
            target:
              entity_id: switch.sonoff_gate
        close_cover:
          - action: switch.turn_on
            target:
              entity_id: switch.sonoff_gate
        stop_cover:
          - action: switch.turn_on
            target:
              entity_id: switch.sonoff_gate
```

Keep the availability template so an unavailable sensor is not interpreted as a closed gate. Existing installations must also apply this in Home Assistant (`availability_template` for an existing legacy cover configuration).

<img width="619" alt="Gate in Home Assistant" src="https://github.com/longzheng/home-gate-detection/assets/484912/69941812-86b0-48dc-8092-12236c1b33cf">

I also expose the combined cover to Apple Home through Home Assistant's HomeKit integration.

![Driveway gate in HomeKit](https://github.com/longzheng/home-gate-detection/assets/484912/af29cedf-1e67-4e5a-be1e-2409672e101c)

## Train and export a model

Open [training/notebook.ipynb](training/notebook.ipynb) in Jupyter with `training/` as the working directory.

1. Put labelled, pre-cropped gate images in `training/dataset/closed/` and `training/dataset/open/`. Use the same gate region as the server, with examples across lighting, weather, and obstructions. Include JPG images in both classes for the notebook's preview cell.
2. Install the notebook dependencies. Its installation cells install PyTorch/torchvision from the CUDA 12.8 index and Ultralytics; adapt the PyTorch installation to your hardware if needed.
3. Run the dataset split cell. It deletes any existing `dataset_split/` directory before recreating the split.
4. Inspect the preprocessing preview, then train from `yolo26n-cls.pt` using `GateClassificationTrainer`.
5. Validate the best checkpoint using `GateClassificationValidator`.
6. Export the best checkpoint to ONNX using the final cell, then copy the exported `best.onnx` to `server/best.onnx` and restart the server.

[training/gate_transforms.py](training/gate_transforms.py) preserves the entire gate crop and stretches it to 224 × 224. Training adds mild color jitter, with no random cropping, flipping, or erasing. Validation uses the same resize and normalization as inference: RGB, CHW, and division by 255, without ImageNet normalization. PIL and Sharp resizing can produce slightly different pixels.

Use the custom validator for standalone validation too. Generic Ultralytics prediction may apply different crops; use the server for deployed inference or explicitly apply the custom transforms. The notebook does not set a fixed epoch count and uses the installed Ultralytics defaults for unspecified training options.

### ONNX model contract

The server expects:

- File: `best.onnx` in the server's working directory.
- Input: `images`, float32, shape `[1, 3, 224, 224]`.
- Output: `output0`, float32, with exactly two class scores in the order **closed, open**.
- Export: image size 224, batch size 1, and `dynamic=False`, as configured in the notebook.

If you change the classes, their order, or the input size, update the classifier to match before deploying the model.

## Development checks

Run from `server/`:

```sh
pnpm test
pnpm lint
```

`pnpm test` compiles the TypeScript and runs the gate-state tests. `pnpm lint` runs TypeScript checking and ESLint.
