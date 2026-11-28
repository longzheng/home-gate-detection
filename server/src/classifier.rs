use std::{fs::File, io::BufWriter, path::Path, time::Instant};

use anyhow::{Context, Result, anyhow, bail, ensure};
use chrono::Utc;
use fast_image_resize::{
    PixelType, Resizer,
    images::{Image, ImageRef},
};
use image::{ExtendedColorType, RgbImage, codecs::jpeg::JpegEncoder};
use ort::{inputs, session::Session, value::TensorRef};
use tracing::debug;

use crate::{
    config::{Config, Crop},
    gate_state::Label,
};

const SIDE: u32 = 224;
const PIXELS: usize = SIDE as usize * SIDE as usize;
const CONFIDENCE_THRESHOLD: f64 = 0.95;

pub struct Classifier {
    session: Session,
    resizer: Resizer,
    cropped: Vec<u8>,
    resized: Image<'static>,
    input: Vec<f32>,
}

impl Classifier {
    pub fn load(path: &Path) -> Result<Self> {
        // One thread reduced inference latency for the gate model with batch size one.
        let session = Session::builder()?
            .with_intra_threads(1)
            .map_err(|error| anyhow!("set ONNX Runtime inference thread count: {error}"))?
            .commit_from_file(path)
            .with_context(|| format!("load ONNX model {}", path.display()))?;
        Ok(Self {
            session,
            resizer: Resizer::new(),
            cropped: Vec::new(),
            resized: Image::new(SIDE, SIDE, PixelType::U8x3),
            input: vec![0.0; 3 * PIXELS],
        })
    }

    pub fn classify(&mut self, snapshot: &[u8], config: &Config) -> Result<Label> {
        let start = Instant::now();
        let image = image::load_from_memory(snapshot)
            .context("decode snapshot")?
            .into_rgb8();
        crop_rgb(&image, config.crop, &mut self.cropped)?;
        let [closed, open] = self.scores(config.crop)?;
        debug!(
            closed,
            open,
            elapsed_ms = start.elapsed().as_secs_f64() * 1000.0,
            "classified snapshot"
        );

        let closed_is_confident = f64::from(closed) > CONFIDENCE_THRESHOLD;
        let open_is_confident = f64::from(open) > CONFIDENCE_THRESHOLD;
        let label = if open_is_confident && (!closed_is_confident || open > closed) {
            Label::Open
        } else if closed_is_confident {
            Label::Closed
        } else {
            save_crop(&self.cropped, config.crop, "not-confident")?;
            bail!("no confident results");
        };

        match label {
            Label::Open if config.save_open => save_crop(&self.cropped, config.crop, "open")?,
            Label::Closed if config.save_closed && rand::random::<f64>() < 0.01 => {
                save_crop(&self.cropped, config.crop, "closed")?;
            }
            _ => (),
        }
        Ok(label)
    }

    fn scores(&mut self, crop: Crop) -> Result<[f32; 2]> {
        let source = ImageRef::new(crop.width, crop.height, &self.cropped, PixelType::U8x3)?;
        self.resizer.resize(&source, &mut self.resized, None)?;

        let (red, rest) = self.input.split_at_mut(PIXELS);
        let (green, blue) = rest.split_at_mut(PIXELS);
        for (index, rgb) in self.resized.buffer().chunks_exact(3).enumerate() {
            red[index] = f32::from(rgb[0]) / 255.0;
            green[index] = f32::from(rgb[1]) / 255.0;
            blue[index] = f32::from(rgb[2]) / 255.0;
        }

        let tensor = TensorRef::from_array_view((
            [1, 3, i64::from(SIDE), i64::from(SIDE)],
            self.input.as_slice(),
        ))?;
        let outputs = self.session.run(inputs!["images" => tensor])?;
        let (_, scores) = outputs
            .get("output0")
            .context("model has no output0")?
            .try_extract_tensor::<f32>()?;
        scores
            .try_into()
            .with_context(|| format!("expected two model scores, received {}", scores.len()))
    }
}

fn crop_rgb(image: &RgbImage, crop: Crop, output: &mut Vec<u8>) -> Result<()> {
    ensure!(
        crop.width <= image.width().saturating_sub(crop.left)
            && crop.height <= image.height().saturating_sub(crop.top),
        "configured crop is outside the {}x{} snapshot",
        image.width(),
        image.height()
    );
    // Copy the rectangle before resizing so the filter only samples inside the gate crop.
    let stride = image.width() as usize * 3;
    let start = crop.left as usize * 3;
    let end = start + crop.width as usize * 3;
    output.clear();
    output.reserve((end - start) * crop.height as usize);
    for row in image
        .as_raw()
        .chunks_exact(stride)
        .skip(crop.top as usize)
        .take(crop.height as usize)
    {
        output.extend_from_slice(&row[start..end]);
    }
    Ok(())
}

fn save_crop(pixels: &[u8], crop: Crop, directory: &str) -> Result<()> {
    let timestamp = Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(':', "_");
    let path = format!("images/{directory}/{timestamp}.jpg");
    let file = File::create(&path).with_context(|| format!("create {path}"))?;
    let mut writer = BufWriter::new(file);
    JpegEncoder::new_with_quality(&mut writer, 80)
        .encode(pixels, crop.width, crop.height, ExtendedColorType::Rgb8)
        .with_context(|| format!("encode {path}"))?;
    std::io::Write::flush(&mut writer).with_context(|| format!("write {path}"))
}
