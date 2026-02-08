"""
Vocal separation using MDX-Net ONNX models — torch-free implementation.

Based on uvr-mdx-infer (https://github.com/seanghay/uvr-mdx-infer)
with torch replaced by numpy/scipy for STFT/iSTFT operations.

Dependencies: onnxruntime, numpy, scipy, librosa
No PyTorch required.
"""

import numpy as np
import librosa
import onnxruntime as ort
from scipy.signal.windows import hann


class ConvTDFNet:
    """STFT/iSTFT processor for MDX-Net (pure numpy, no torch)."""

    def __init__(self, dim_f, dim_t, n_fft, hop=1024):
        self.dim_c = 4
        self.dim_f = dim_f
        self.dim_t = 2 ** dim_t
        self.n_fft = n_fft
        self.hop = hop
        self.n_bins = self.n_fft // 2 + 1
        self.chunk_size = hop * (self.dim_t - 1)
        self.window = hann(self.n_fft, sym=False).astype(np.float32)
        self.n = 11 // 2  # L=11

    def stft(self, x):
        """Compute STFT on audio chunks.

        Input: (batch, 2, chunk_size) where 2 = stereo channels.
        Output: (batch, 4, dim_f, dim_t) where 4 = [L_real, L_imag, R_real, R_imag].

        Matches torch.stft(center=True) by applying reflection padding
        of n_fft//2 on each side before computing the STFT.
        """
        batch = x.shape[0]
        # Flatten stereo: (batch, 2, chunk_size) -> (batch*2, chunk_size)
        x = x.reshape(-1, self.chunk_size)
        n_channels = x.shape[0]
        center_pad = self.n_fft // 2

        results = []
        for i in range(n_channels):
            # Reflection pad to match torch.stft(center=True)
            x_padded = np.pad(x[i], (center_pad, center_pad), mode='reflect')

            # Frame the padded signal
            frames = librosa.util.frame(
                x_padded, frame_length=self.n_fft, hop_length=self.hop
            )  # (n_fft, dim_t) where dim_t = 256

            # Apply window and FFT
            windowed = frames * self.window[:, np.newaxis]
            spectrum = np.fft.rfft(windowed, n=self.n_fft, axis=0)  # (n_bins, dim_t)

            # Stack real and imaginary as separate channels
            real = spectrum.real.astype(np.float32)
            imag = spectrum.imag.astype(np.float32)
            results.append(np.stack([real, imag], axis=0))  # (2, n_bins, dim_t)

        stft_out = np.stack(results, axis=0)  # (batch*2, 2, n_bins, dim_t)

        # Reshape: (batch*2, 2, n_bins, dim_t) -> (batch, 4, n_bins, dim_t)
        stft_out = stft_out.reshape(batch, self.dim_c, self.n_bins, self.dim_t)

        # Trim frequency dimension to dim_f
        return stft_out[:, :, :self.dim_f, :]

    def istft(self, x, freq_pad=None):
        """Compute inverse STFT.

        Input: (batch, 4, dim_f, dim_t).
        Output: (batch, 2, chunk_size) where 2 = stereo channels.

        Matches torch.istft(center=True) behavior.
        """
        batch = x.shape[0]

        # Pad frequency back to full n_bins
        if freq_pad is None:
            pad_shape = (batch, x.shape[1], self.n_bins - self.dim_f, self.dim_t)
            freq_pad = np.zeros(pad_shape, dtype=np.float32)
        x = np.concatenate([x, freq_pad], axis=2)  # (batch, 4, n_bins, dim_t)

        # Reshape: (batch, 4, n_bins, dim_t)
        #   -> (batch, 2, 2, n_bins, dim_t)  [stereo, real/imag]
        #   -> (batch*2, 2, n_bins, dim_t)
        c = 2  # stereo channels
        x = x.reshape(batch, c, 2, self.n_bins, self.dim_t)
        x = x.reshape(batch * c, 2, self.n_bins, self.dim_t)

        center_pad = self.n_fft // 2
        padded_length = self.chunk_size + self.n_fft

        results = []
        for i in range(x.shape[0]):
            real = x[i, 0]  # (n_bins, dim_t)
            imag = x[i, 1]  # (n_bins, dim_t)
            spectrum = real + 1j * imag  # (n_bins, dim_t)

            n_frames = spectrum.shape[1]

            # Overlap-add iSTFT
            output = np.zeros(padded_length, dtype=np.float32)
            window_sum = np.zeros(padded_length, dtype=np.float32)

            for frame_idx in range(n_frames):
                frame_signal = np.fft.irfft(
                    spectrum[:, frame_idx], n=self.n_fft
                ).astype(np.float32)
                frame_signal *= self.window

                start = frame_idx * self.hop
                end = start + self.n_fft
                output[start:end] += frame_signal
                window_sum[start:end] += self.window ** 2

            # Normalize by window sum (COLA condition)
            nonzero = window_sum > 1e-8
            output[nonzero] /= window_sum[nonzero]

            # Remove center padding: extract the middle chunk_size samples
            results.append(output[center_pad:center_pad + self.chunk_size])

        out = np.stack(results, axis=0)  # (batch*2, chunk_size)
        return out.reshape(batch, c, self.chunk_size)


class VocalSeparator:
    """MDX-Net ONNX vocal separation — no torch dependency."""

    def __init__(self, model_path: str, dim_f=2048, dim_t=8, n_fft=6144,
                 chunks=15, margin=44100, denoise=True):
        self.model = ort.InferenceSession(
            model_path, providers=['CPUExecutionProvider']
        )
        self.net = ConvTDFNet(dim_f=dim_f, dim_t=dim_t, n_fft=n_fft)
        self.chunks = chunks
        self.margin = margin
        self.denoise = denoise

    def demix(self, mix):
        """Segment audio and run inference on each chunk."""
        samples = mix.shape[-1]
        margin = self.margin
        chunk_size = self.chunks * 44100

        if margin > chunk_size:
            margin = chunk_size

        segmented_mix = {}
        if self.chunks == 0 or samples < chunk_size:
            chunk_size = samples

        counter = -1
        for skip in range(0, samples, chunk_size):
            counter += 1
            s_margin = 0 if counter == 0 else margin
            end = min(skip + chunk_size + margin, samples)
            start = skip - s_margin
            segmented_mix[skip] = mix[:, start:end].copy()
            if end == samples:
                break

        return self._demix_base(segmented_mix, margin_size=margin)

    def _demix_base(self, mixes, margin_size):
        """Run ONNX inference on each audio segment."""
        chunked_sources = []

        for mix_key in mixes:
            cmix = mixes[mix_key]
            n_sample = cmix.shape[1]
            model = self.net
            trim = model.n_fft // 2
            gen_size = model.chunk_size - 2 * trim
            pad = gen_size - n_sample % gen_size
            mix_p = np.concatenate(
                (np.zeros((2, trim)), cmix, np.zeros((2, pad)), np.zeros((2, trim))), 1
            ).astype(np.float32)

            mix_waves = []
            i = 0
            while i < n_sample + pad:
                waves = mix_p[:, i:i + model.chunk_size].copy()
                mix_waves.append(waves)
                i += gen_size

            mix_waves = np.array(mix_waves, dtype=np.float32)  # (n_chunks, 2, chunk_size)

            # STFT
            spek = model.stft(mix_waves)

            # ONNX inference
            if self.denoise:
                spec_pred = (
                    -self.model.run(None, {"input": -spek})[0] * 0.5
                    + self.model.run(None, {"input": spek})[0] * 0.5
                )
            else:
                spec_pred = self.model.run(None, {"input": spek})[0]

            # iSTFT
            tar_waves = model.istft(spec_pred)  # (n_chunks, 2, chunk_size)

            # Trim and concatenate
            tar_signal = (
                tar_waves[:, :, trim:-trim]
                .transpose(1, 0, 2)
                .reshape(2, -1)[:, :-pad]
            )

            start = 0 if mix_key == 0 else margin_size
            end = None if mix_key == list(mixes.keys())[-1] else -margin_size

            if margin_size == 0:
                end = None

            chunked_sources.append(tar_signal[:, start:end])

        return np.concatenate(chunked_sources, axis=-1)

    def separate(self, audio_44k_stereo):
        """Separate vocals from stereo 44.1kHz audio.

        Args:
            audio_44k_stereo: (2, samples) float32 array at 44100Hz

        Returns:
            vocals: (2, samples) float32 array at 44100Hz
        """
        mix = audio_44k_stereo
        sources = self.demix(mix)
        # sources = estimated vocal signal
        # vocals = mix - instrumental (or direct vocal output)
        return sources


def separate_vocals(audio_16k: np.ndarray, model_path: str,
                    denoise: bool = True) -> np.ndarray:
    """High-level API: separate vocals from 16kHz mono audio.

    Args:
        audio_16k: 16kHz mono float32 numpy array
        model_path: path to ONNX model file
        denoise: enable denoising (default True)

    Returns:
        vocals_16k: 16kHz mono float32 numpy array (vocals only)
    """
    # Upsample to 44.1kHz (MDX-Net operates at 44.1kHz)
    audio_44k = librosa.resample(audio_16k, orig_sr=16000, target_sr=44100)

    # Mono → stereo (duplicate)
    stereo = np.stack([audio_44k, audio_44k], axis=0).astype(np.float32)

    # Run separation
    separator = VocalSeparator(model_path, denoise=denoise)
    # The ONNX model predicts the vocal spectrogram from the mix spectrogram.
    # We subtract the predicted vocals from the mix to get instrumentals,
    # or use the predicted output directly as vocals.
    # In uvr-mdx-infer: mix - opt = vocals, opt = instrumental
    # But for target_name="vocals", the model directly predicts vocals.
    vocal_sources = separator.separate(stereo)

    # Stereo → mono
    vocals_mono = vocal_sources.mean(axis=0)

    # Downsample back to 16kHz
    vocals_16k = librosa.resample(vocals_mono, orig_sr=44100, target_sr=16000)

    return vocals_16k.astype(np.float32)
