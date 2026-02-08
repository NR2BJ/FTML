"""
Vocal separation using MDX-Net ONNX models — torch-free implementation.

Based on uvr-mdx-infer (https://github.com/seanghay/uvr-mdx-infer)
with torch replaced by numpy/scipy for STFT/iSTFT operations.
All FFT operations are vectorized (batch rfft/irfft) for performance.

Dependencies: onnxruntime, numpy, scipy, librosa
No PyTorch required.
"""

import logging
import time

import numpy as np
import librosa
import onnxruntime as ort
from scipy.signal.windows import hann

log = logging.getLogger("whisper")


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

        # Precompute window^2 overlap-add sum for iSTFT normalization.
        # This is identical for every istft call, so compute once.
        window_sq = self.window ** 2
        padded_length = self.chunk_size + self.n_fft
        window_sum = np.zeros(padded_length, dtype=np.float32)
        for frame_idx in range(self.dim_t):
            start = frame_idx * self.hop
            window_sum[start:start + self.n_fft] += window_sq
        window_sum[window_sum < 1e-8] = 1.0  # avoid division by zero
        self._window_sum = window_sum

    def stft(self, x):
        """Compute STFT on audio chunks (vectorized).

        Input: (batch, 2, chunk_size) where 2 = stereo channels.
        Output: (batch, 4, dim_f, dim_t) where 4 = [L_real, L_imag, R_real, R_imag].

        Matches torch.stft(center=True) by applying reflection padding
        of n_fft//2 on each side before computing the STFT.
        """
        batch = x.shape[0]
        # Flatten stereo: (batch, 2, chunk_size) -> (batch*2, chunk_size)
        x = x.reshape(-1, self.chunk_size)
        n_ch = x.shape[0]
        center_pad = self.n_fft // 2

        # Pad all channels at once
        x_padded = np.pad(x, ((0, 0), (center_pad, center_pad)), mode='reflect')
        # x_padded: (n_ch, chunk_size + n_fft)

        # Frame all channels using stride tricks (read-only view, no copy)
        padded_len = x_padded.shape[1]
        shape = (n_ch, self.n_fft, self.dim_t)
        strides = (
            x_padded.strides[0],            # between channels
            x_padded.strides[1],            # within frame (consecutive samples)
            x_padded.strides[1] * self.hop  # between frames
        )
        frames = np.lib.stride_tricks.as_strided(x_padded, shape=shape, strides=strides)
        # frames: (n_ch, n_fft, dim_t) — read-only strided view

        # Apply window and batch FFT across all channels at once
        windowed = frames * self.window[np.newaxis, :, np.newaxis]
        spectrum = np.fft.rfft(windowed, n=self.n_fft, axis=1)
        # spectrum: (n_ch, n_bins, dim_t) complex

        # Split real/imag and interleave per channel
        ri = np.stack([spectrum.real.astype(np.float32),
                       spectrum.imag.astype(np.float32)], axis=1)
        # ri: (n_ch, 2, n_bins, dim_t)

        # Reshape: (n_ch, 2, n_bins, dim_t) -> (batch, 4, n_bins, dim_t)
        stft_out = ri.reshape(batch, self.dim_c, self.n_bins, self.dim_t)

        # Trim frequency dimension to dim_f
        return stft_out[:, :, :self.dim_f, :]

    def istft(self, x, freq_pad=None):
        """Compute inverse STFT (vectorized).

        Input: (batch, 4, dim_f, dim_t).
        Output: (batch, 2, chunk_size) where 2 = stereo channels.

        Uses batch irfft to process all frames in a single call.
        """
        batch = x.shape[0]

        # Pad frequency back to full n_bins
        if freq_pad is None:
            pad_shape = (batch, x.shape[1], self.n_bins - self.dim_f, self.dim_t)
            freq_pad = np.zeros(pad_shape, dtype=np.float32)
        x = np.concatenate([x, freq_pad], axis=2)  # (batch, 4, n_bins, dim_t)

        # Reshape: (batch, 4) -> (batch, 2stereo, 2ri) -> (batch*2, 2ri)
        c = 2  # stereo channels
        x = x.reshape(batch, c, 2, self.n_bins, self.dim_t)
        x = x.reshape(batch * c, 2, self.n_bins, self.dim_t)
        n_ch = x.shape[0]

        # Reconstruct complex spectrum for all channels
        spectrum = x[:, 0] + 1j * x[:, 1]  # (n_ch, n_bins, dim_t)

        # Batch irfft: all channels and all frames in one call
        all_frames = np.fft.irfft(spectrum, n=self.n_fft, axis=1).astype(np.float32)
        # all_frames: (n_ch, n_fft, dim_t)

        # Apply window
        all_frames *= self.window[np.newaxis, :, np.newaxis]

        # Overlap-add: 256 iterations of cheap slice additions (no FFT)
        center_pad = self.n_fft // 2
        padded_length = self.chunk_size + self.n_fft
        output = np.zeros((n_ch, padded_length), dtype=np.float32)

        for frame_idx in range(self.dim_t):
            start = frame_idx * self.hop
            end = start + self.n_fft
            output[:, start:end] += all_frames[:, :, frame_idx]

        # Normalize by precomputed window sum
        output /= self._window_sum[np.newaxis, :]

        # Remove center padding
        output = output[:, center_pad:center_pad + self.chunk_size]

        return output.reshape(batch, c, self.chunk_size)


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
        total_segments = len(mixes)

        for seg_idx, mix_key in enumerate(mixes):
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

            mix_waves = np.array(mix_waves, dtype=np.float32)

            t0 = time.time()
            spek = model.stft(mix_waves)
            t_stft = time.time() - t0

            t0 = time.time()
            if self.denoise:
                spec_pred = (
                    -self.model.run(None, {"input": -spek})[0] * 0.5
                    + self.model.run(None, {"input": spek})[0] * 0.5
                )
            else:
                spec_pred = self.model.run(None, {"input": spek})[0]
            t_onnx = time.time() - t0

            t0 = time.time()
            tar_waves = model.istft(spec_pred)
            t_istft = time.time() - t0

            if seg_idx == 0 or seg_idx == total_segments - 1 or (seg_idx + 1) % 10 == 0:
                log.info(f"[vocal_sep] Segment {seg_idx+1}/{total_segments}: "
                         f"stft={t_stft:.2f}s onnx={t_onnx:.2f}s istft={t_istft:.2f}s "
                         f"batch={mix_waves.shape[0]}")

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
        return self.demix(audio_44k_stereo)


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
    t_total = time.time()

    # Upsample to 44.1kHz (MDX-Net operates at 44.1kHz)
    t0 = time.time()
    audio_44k = librosa.resample(audio_16k, orig_sr=16000, target_sr=44100)
    log.info(f"[vocal_sep] Resample 16k->44.1k: {time.time()-t0:.1f}s "
             f"({len(audio_16k)} -> {len(audio_44k)} samples)")

    # Mono → stereo (duplicate)
    stereo = np.stack([audio_44k, audio_44k], axis=0).astype(np.float32)

    # Run separation
    t0 = time.time()
    separator = VocalSeparator(model_path, denoise=denoise)
    log.info(f"[vocal_sep] ONNX session created in {time.time()-t0:.1f}s")

    t0 = time.time()
    vocal_sources = separator.separate(stereo)
    log.info(f"[vocal_sep] Separation done in {time.time()-t0:.1f}s")

    # Stereo → mono
    vocals_mono = vocal_sources.mean(axis=0)

    # Downsample back to 16kHz
    t0 = time.time()
    vocals_16k = librosa.resample(vocals_mono, orig_sr=44100, target_sr=16000)
    log.info(f"[vocal_sep] Resample 44.1k->16k: {time.time()-t0:.1f}s "
             f"({len(vocals_mono)} -> {len(vocals_16k)} samples)")

    log.info(f"[vocal_sep] Total pipeline: {time.time()-t_total:.1f}s")
    return vocals_16k.astype(np.float32)
