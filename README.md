# home-gate-detection

Using a custom YOLOv8-based image classification model to detect if my driveway gate is open or closed and set state in Home Assistant.

---

## Background

I like home automation and I've already automated the garage door, so I wanted to automate the driveway gate too. It is a swing gate controlled by a FAAC EO24S controller which I've already set up a WiFi relay to open and close, but I couldn't see a way to get the open or closed state of the gate.

I could have used a magnetic reed switch like most smart garage controllers do, but I didn't like the idea of a wire moving around with the swing arms.

I already had a CCTV camera with unobstructed view of the gate, which gave me an idea to give neural networks a go which I haven't done before.

## The model

I came across [YOLOv8](https://docs.ultralytics.com/), an impressive free and open-source image object detection, segmentation and classiciation model.

For what I need, [image classification](https://docs.ultralytics.com/tasks/classify/) was an ideal fit because I don't need to identify where the gate was in the image or its shape outline, just if it was open or closed, effective a binary state.

## Training

I used [Roboflow](https://roboflow.com/) to quickly label a dataset from my CCTV camera footage.

Since I was planning to be only use a crop of the gate for the actual model inference, I also pre-cropped all my training images before uploading them to Roboflow.

I tried to find examples of open and closed gates, in different weather and lighting conditions, as well as with vehicles and people across it. I ended up with 87 images roughly equally split between open and closed.

![Sample of training images](https://github.com/longzheng/home-gate-detection/assets/484912/2435e1a2-046c-497f-937d-59c6efa9f60c)

I trained 300 epochs using the `yolov8s-cls.pt` pretrained model using my RTX 4070 Ti GPU which only took a few minutes.

![Training result](https://github.com/longzheng/home-gate-detection/assets/484912/db98bab3-d17e-4966-90cd-8f26e1101a44)


## Inference

I planned to run this on my Windows home server which only has an integrated GPU, so it was practically going to run on CPU. I found the ONNX format which could be ran in Node.js using [Microsoft's ONNX Runtime](https://onnxruntime.ai/) so I exported the model to ONNX which YOLO CLI had built-in support for.

I then wrote a simple Node.js script to basically loop through downloading the latest snapshot from my CCTV camera, crop it, run inference with the custom model, filter and find the most confident prediction.

Because I used the ["small" pretrained model](https://docs.ultralytics.com/tasks/classify/), inference only took approximately 80ms on a Intel i5-9600K CPU. In fact downloading the image was significantly slower at approximately 900ms. So the whole update loop takes around 1 second which is good enough for my needs.

## Home Assistant

I set up my Node script to push the state into my Home Assistant as a `binary_sensor` by simplying `POST`ing the state to Home Assistant.

```js
        {
            state: classification === "open" ? "on" : "off",
            attributes: {
                device_class: "garage_door",
                friendly_name: "Driveway gate",
            },
        },
```

I wanted to tie together this open/closed state with my existing Wifi relay to more accurately represent the gate as a cover entity in Home Assistant so I used a template to merge the two together

```yaml
cover:
  - platform: template
    covers:
      driveway_gate:
        device_class: gate
        friendly_name: "Driveway gate"
        value_template: "{{ is_state('binary_sensor.driveway_gate', 'on') }}"
        open_cover:
          service: switch.turn_on
          target:
            entity_id: switch.sonoff_gate
        close_cover:
          service: switch.turn_on
          target:
            entity_id: switch.sonoff_gate
        stop_cover:
          service: switch.turn_on
          target:
            entity_id: switch.sonoff_gate
```

<img width="619" alt="Gate in Home Assistant" src="https://github.com/longzheng/home-gate-detection/assets/484912/69941812-86b0-48dc-8092-12236c1b33cf">

Finally, since I do most of my actual home management in Apple Home, so I re-exported the merged gate entity to HomeKit.

![Driveway gate in HomeKit](https://github.com/longzheng/home-gate-detection/assets/484912/af29cedf-1e67-4e5a-be1e-2409672e101c)
