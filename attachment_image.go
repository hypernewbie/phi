package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"path/filepath"
	"strings"
)

func classifyAttachmentFile(path, name, claimedMIME string, decodeMu *chan struct{}, maxPixels int64, maxDimension int) (kind, mimeType, extension string, err error) {
	f, err := openAttachmentRegularNoFollow(path)
	if err != nil {
		return "", "", "", errAttachmentStorage
	}
	prefix, readErr := io.ReadAll(io.LimitReader(f, attachmentImageProbeBytes))
	_ = f.Close()
	if readErr != nil {
		return "", "", "", errAttachmentStorage
	}
	claimed := strings.HasPrefix(strings.ToLower(claimedMIME), "image/") || isImageName(name)
	switch {
	case bytes.HasPrefix(prefix, []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}):
		animated, scanErr := hasAPNGAnimationFile(path)
		if scanErr != nil || animated {
			return "", "", "", errAttachmentUnsupported
		}
		mimeType, extension = "image/png", ".png"
	case len(prefix) >= 3 && prefix[0] == 0xff && prefix[1] == 0xd8 && prefix[2] == 0xff:
		mimeType, extension = "image/jpeg", ".jpg"
	case bytes.HasPrefix(prefix, []byte("GIF87a")) || bytes.HasPrefix(prefix, []byte("GIF89a")):
		return "", "", "", errAttachmentUnsupported
	case len(prefix) >= 12 && string(prefix[:4]) == "RIFF" && string(prefix[8:12]) == "WEBP":
		return "", "", "", errAttachmentUnsupported
	case len(prefix) >= 2 && string(prefix[:2]) == "BM":
		return "", "", "", errAttachmentUnsupported
	case isUnsupportedISOImage(prefix):
		return "", "", "", errAttachmentUnsupported
	case looksLikeSVG(prefix) || strings.EqualFold(strings.TrimSpace(claimedMIME), "image/svg+xml"):
		return "", "", "", errAttachmentUnsupported
	default:
		if claimed {
			return "", "", "", errAttachmentUnsupported
		}
		return "file", "application/octet-stream", ".bin", nil
	}

	cfgFile, err := openAttachmentRegularNoFollow(path)
	if err != nil {
		return "", "", "", errAttachmentStorage
	}
	cfg, format, cfgErr := image.DecodeConfig(cfgFile)
	_ = cfgFile.Close()
	if cfgErr != nil || format != "png" && format != "jpeg" {
		return "", "", "", errAttachmentUnsupported
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxDimension || cfg.Height > maxDimension || int64(cfg.Width) > maxPixels/int64(cfg.Height) {
		return "", "", "", errAttachmentUnsupported
	}
	if decodeMu != nil {
		*decodeMu <- struct{}{}
		defer func() { <-*decodeMu }()
	}
	full, err := openAttachmentRegularNoFollow(path)
	if err != nil {
		return "", "", "", errAttachmentStorage
	}
	decoded, decodedFormat, decodeErr := image.Decode(full)
	_ = full.Close()
	if decodeErr != nil || decodedFormat != format || decoded == nil {
		return "", "", "", errAttachmentUnsupported
	}
	return "image", mimeType, extension, nil
}

func isImageName(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".apng", ".webp", ".bmp", ".svg", ".svgz", ".heic", ".heif", ".avif":
		return true
	default:
		return false
	}
}

func hasAPNGAnimationFile(path string) (bool, error) {
	f, err := openAttachmentRegularNoFollow(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return false, err
	}
	var signature [8]byte
	if _, err := io.ReadFull(f, signature[:]); err != nil || !bytes.Equal(signature[:], []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}) {
		return false, errors.New("invalid PNG signature")
	}
	var scanned int64 = 8
	for chunks := 0; chunks < 4096; chunks++ {
		var header [8]byte
		if _, err := io.ReadFull(f, header[:]); err != nil {
			return false, nil
		}
		scanned += 8
		length := int64(binary.BigEndian.Uint32(header[:4]))
		kind := string(header[4:8])
		if kind == "acTL" {
			return true, nil
		}
		if kind == "IDAT" || kind == "IEND" {
			return false, nil
		}
		if length < 0 || scanned+length+4 > info.Size() {
			return false, nil
		}
		if scanned+length+4 > attachmentImageProbeBytes {
			// acTL must precede IDAT. If the bounded scan cannot
			// establish that, refuse the image instead of treating a
			// possible animated PNG as an ordinary static PNG.
			return true, nil
		}
		if _, err := f.Seek(length+4, io.SeekCurrent); err != nil {
			return false, err
		}
		scanned += length + 4
	}
	return true, nil
}

func isUnsupportedISOImage(data []byte) bool {
	if len(data) < 12 || string(data[4:8]) != "ftyp" {
		return false
	}
	brand := string(data[8:12])
	switch brand {
	case "heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis":
		return true
	default:
		return false
	}
}

func looksLikeSVG(data []byte) bool {
	text := strings.ToLower(string(data))
	text = strings.TrimPrefix(text, "\xef\xbb\xbf")
	return strings.Contains(text, "<svg") || (strings.Contains(text, "<?xml") && strings.Contains(text, "<svg"))
}
