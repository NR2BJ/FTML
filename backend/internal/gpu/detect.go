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
	VRAMFree  int64  `json:"vram_free"`  // bytes, -1 if unavailable
	Driver    string `json:"driver"`     // e.g. "i915"
}

// cachedStatic holds device name, driver, and total VRAM (detected once).
// Dynamic VRAM (free/used) is read on each call when sysfs supports it.
var (
	cachedStatic   *GPUInfo
	staticOnce     sync.Once
	vramUsedPath   string // sysfs path to VRAM used (empty if not available)
	hasDynamicVRAM bool   // whether dynamic VRAM reading is possible
)

// Known VRAM sizes for Intel Arc GPUs (bytes)
var knownVRAM = map[string]int64{
	"56a5": 6 * 1024 * 1024 * 1024,  // Arc A380 — 6GB
	"56a6": 4 * 1024 * 1024 * 1024,  // Arc A310 — 4GB
	"5690": 16 * 1024 * 1024 * 1024, // Arc A770 — 16GB
	"5692": 8 * 1024 * 1024 * 1024,  // Arc A750 — 8GB
	"56c0": 12 * 1024 * 1024 * 1024, // Arc B580 — 12GB
	"56c1": 10 * 1024 * 1024 * 1024, // Arc B570 — 10GB
}

// DetectGPU returns GPU info with dynamic VRAM usage.
// Static info (device, driver, total VRAM) is cached on first call.
// Dynamic VRAM usage is re-read from sysfs on every call when available.
func DetectGPU() *GPUInfo {
	staticOnce.Do(func() {
		cachedStatic = detectGPUStatic()
		log.Printf("[gpu] detected: device=%q vram_total=%d MB driver=%s dynamic_vram=%v",
			cachedStatic.Device,
			cachedStatic.VRAMTotal/1024/1024,
			cachedStatic.Driver,
			hasDynamicVRAM)
	})

	// Copy static info
	info := &GPUInfo{
		Device:    cachedStatic.Device,
		VRAMTotal: cachedStatic.VRAMTotal,
		VRAMFree:  cachedStatic.VRAMFree,
		Driver:    cachedStatic.Driver,
	}

	// Read dynamic VRAM usage if sysfs path available
	if hasDynamicVRAM && vramUsedPath != "" && info.VRAMTotal > 0 {
		vramUsed, err := readSysfsInt(vramUsedPath)
		if err == nil && vramUsed >= 0 {
			info.VRAMFree = info.VRAMTotal - vramUsed
		}
	}

	return info
}

func detectGPUStatic() *GPUInfo {
	info := &GPUInfo{VRAMFree: -1} // -1 = usage unavailable by default

	cards, err := filepath.Glob("/sys/class/drm/card[0-9]*")
	if err != nil {
		return info
	}

	// First pass: look for cards with sysfs VRAM info (AMD-style)
	for _, card := range cards {
		base := filepath.Base(card)
		if strings.Contains(base, "-") {
			continue
		}

		deviceDir := filepath.Join(card, "device")

		vramTotalPath := filepath.Join(deviceDir, "mem_info_vram_total")
		vramBytes, err := readSysfsInt(vramTotalPath)
		if err != nil || vramBytes == 0 {
			continue
		}

		info.VRAMTotal = vramBytes

		usedPath := filepath.Join(deviceDir, "mem_info_vram_used")
		if _, err := os.Stat(usedPath); err == nil {
			vramUsedPath = usedPath
			hasDynamicVRAM = true
			// Read initial value
			vramUsed, err := readSysfsInt(usedPath)
			if err == nil && vramUsed >= 0 {
				info.VRAMFree = vramBytes - vramUsed
			} else {
				info.VRAMFree = vramBytes
			}
		}

		info.Device = readDeviceName(deviceDir)
		driverLink, err := os.Readlink(filepath.Join(deviceDir, "driver"))
		if err == nil {
			info.Driver = filepath.Base(driverLink)
		}
		return info
	}

	// Second pass (fallback): detect by PCI ID even without VRAM sysfs
	// Intel Arc GPUs don't expose mem_info_vram_total
	for _, card := range cards {
		base := filepath.Base(card)
		if strings.Contains(base, "-") {
			continue
		}

		deviceDir := filepath.Join(card, "device")
		vendorID, deviceID := readPCIIDs(deviceDir)
		if vendorID == "" || deviceID == "" {
			continue
		}

		if isKnownDiscreteGPU(vendorID, deviceID) {
			info.Device = readDeviceName(deviceDir)

			if vram, ok := knownVRAM[deviceID]; ok {
				info.VRAMTotal = vram
				// VRAMFree stays -1 → frontend shows "usage unavailable"
			}

			driverLink, err := os.Readlink(filepath.Join(deviceDir, "driver"))
			if err == nil {
				info.Driver = filepath.Base(driverLink)
			}
			return info
		}
	}

	return info
}

// isKnownDiscreteGPU checks if a PCI device is a known discrete GPU
func isKnownDiscreteGPU(vendorID, deviceID string) bool {
	if vendorID == "8086" {
		switch deviceID {
		case "56a5", "56a6", "5690", "5691", "5692", "56a0", "56a1", "56c0", "56c1":
			return true
		}
	}
	// NVIDIA (10de) and AMD (1002) are always discrete
	if vendorID == "10de" || vendorID == "1002" {
		return true
	}
	return false
}

// readPCIIDs extracts vendor and device IDs from uevent
func readPCIIDs(deviceDir string) (string, string) {
	ueventPath := filepath.Join(deviceDir, "uevent")
	data, err := os.ReadFile(ueventPath)
	if err != nil {
		return "", ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PCI_ID=") {
			parts := strings.Split(strings.TrimPrefix(line, "PCI_ID="), ":")
			if len(parts) == 2 {
				return strings.ToLower(parts[0]), strings.ToLower(parts[1])
			}
		}
	}
	return "", ""
}

func readSysfsInt(path string) (int64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
}

func readDeviceName(deviceDir string) string {
	ueventPath := filepath.Join(deviceDir, "uevent")
	data, err := os.ReadFile(ueventPath)
	if err != nil {
		return "Unknown GPU"
	}

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
