package gpu

import (
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// GPUInfo holds detected GPU information
type GPUInfo struct {
	Device    string `json:"device"`     // e.g. "Intel Arc A380"
	VRAMTotal int64  `json:"vram_total"` // bytes, 0 if unknown
	VRAMFree  int64  `json:"vram_free"`  // bytes, 0 if unknown
	Driver    string `json:"driver"`     // e.g. "i915"
}

var (
	cachedGPU  *GPUInfo
	detectOnce sync.Once
)

// DetectGPU probes the system for discrete GPU VRAM info via sysfs.
// Uses sync.Once — safe to call multiple times.
func DetectGPU() *GPUInfo {
	detectOnce.Do(func() {
		cachedGPU = detectGPU()
		log.Printf("[gpu] detected: device=%q vram_total=%d MB driver=%s",
			cachedGPU.Device,
			cachedGPU.VRAMTotal/1024/1024,
			cachedGPU.Driver)
	})
	return cachedGPU
}

func detectGPU() *GPUInfo {
	info := &GPUInfo{}

	// Scan /sys/class/drm/card* for discrete GPUs with VRAM info
	cards, err := filepath.Glob("/sys/class/drm/card[0-9]*")
	if err != nil {
		return info
	}

	for _, card := range cards {
		// Skip render nodes (cardN-XXX)
		base := filepath.Base(card)
		if strings.Contains(base, "-") {
			continue
		}

		deviceDir := filepath.Join(card, "device")

		// Check for discrete GPU VRAM
		vramPath := filepath.Join(deviceDir, "mem_info_vram_total")
		vramBytes, err := readSysfsInt(vramPath)
		if err != nil || vramBytes == 0 {
			continue // Not a discrete GPU or no VRAM info
		}

		info.VRAMTotal = vramBytes

		// Try to read free VRAM
		vramFreePath := filepath.Join(deviceDir, "mem_info_vram_used")
		vramUsed, err := readSysfsInt(vramFreePath)
		if err == nil && vramUsed > 0 {
			info.VRAMFree = vramBytes - vramUsed
		}

		// Read device name from uevent
		info.Device = readDeviceName(deviceDir)

		// Read driver name
		driverLink, err := os.Readlink(filepath.Join(deviceDir, "driver"))
		if err == nil {
			info.Driver = filepath.Base(driverLink)
		}

		// Found a discrete GPU with VRAM, use it
		break
	}

	return info
}

func readSysfsInt(path string) (int64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
}

func readDeviceName(deviceDir string) string {
	// Try uevent for device info
	ueventPath := filepath.Join(deviceDir, "uevent")
	data, err := os.ReadFile(ueventPath)
	if err != nil {
		return "Unknown GPU"
	}

	// Parse PCI_ID to identify common Intel GPUs
	var vendorID, deviceID string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PCI_ID=") {
			parts := strings.Split(strings.TrimPrefix(line, "PCI_ID="), ":")
			if len(parts) == 2 {
				vendorID = strings.ToLower(parts[0])
				deviceID = strings.ToLower(parts[1])
			}
		}
	}

	// Known Intel Arc GPU device IDs
	if vendorID == "8086" {
		switch deviceID {
		case "56a5":
			return "Intel Arc A380"
		case "56a6":
			return "Intel Arc A310"
		case "5690":
			return "Intel Arc A770"
		case "5691":
			return "Intel Arc A730M"
		case "5692":
			return "Intel Arc A750"
		case "56a0":
			return "Intel Arc A770M"
		case "56a1":
			return "Intel Arc A730M"
		case "56c0":
			return "Intel Arc B580"
		case "56c1":
			return "Intel Arc B570"
		default:
			return "Intel GPU (" + deviceID + ")"
		}
	}

	return "GPU (" + vendorID + ":" + deviceID + ")"
}
