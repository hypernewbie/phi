package rpc

// TitleFor returns the phi-owned title: supplied, or prefix+basename(cwd).
func TitleFor(cwd, supplied string) string {
	if supplied != "" {
		return supplied
	}
	return DefaultTitlePrefix + basename(cwd)
}

func basename(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[i+1:]
		}
	}
	return path
}
