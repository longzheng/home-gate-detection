"""Full-frame classification transforms for the pre-cropped gate images."""

from copy import copy

from torchvision import transforms as T
from ultralytics.models.yolo.classify import ClassificationTrainer, ClassificationValidator


MODEL_SIZE = 224


def gate_transforms(size=MODEL_SIZE, augment=False):
    """Keep the whole ROI; produce RGB CHW floats in [0, 1], as in Node.

    PIL and Sharp use different resize implementations, so this matches the
    geometry and normalization contract, not necessarily every pixel exactly.
    """
    transforms = [T.Resize((size, size), interpolation=T.InterpolationMode.LANCZOS)]
    if augment:
        # Photometric variation preserves gate position and the full field of view.
        transforms.append(T.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.1))
    transforms.append(T.ToTensor())  # RGB uint8 -> float32 CHW / 255; no ImageNet normalization
    return T.Compose(transforms)


class GateClassificationValidator(ClassificationValidator):
    def build_dataset(self, img_path):
        dataset = super().build_dataset(img_path)
        dataset.torch_transforms = gate_transforms(self.args.imgsz)
        return dataset


class GateClassificationTrainer(ClassificationTrainer):
    def build_dataset(self, img_path, mode="train", batch=None):
        dataset = super().build_dataset(img_path, mode, batch)
        dataset.torch_transforms = gate_transforms(self.args.imgsz, augment=mode == "train")
        return dataset

    def get_validator(self):
        self.loss_names = ["loss"]
        return GateClassificationValidator(
            self.test_loader, self.save_dir, args=copy(self.args), _callbacks=self.callbacks
        )
