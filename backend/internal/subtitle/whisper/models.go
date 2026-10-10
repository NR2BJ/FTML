package whisper

const DefaultModelID = "OpenVINO/whisper-large-v3-int8-ov"

func SupportedModel(id string) bool {
	return id == DefaultModelID || id == "Qwen/Qwen3-ASR-1.7B" || id == "Qwen/Qwen3-ASR-0.6B"
}
