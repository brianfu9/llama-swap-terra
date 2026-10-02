package perf

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/mostlygeek/llama-swap/internal/logmon"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

func getGpuStats(ctx context.Context, every time.Duration, logger *logmon.Monitor) (chan []GpuStat, error) {
	if ch, err := tryNvidiaSmiWindows(ctx, every, logger); err == nil {
		logger.Info("using nvidia-smi for GPU monitoring")
		return ch, nil
	} else {
		logger.Debugf("nvidia-smi: %s", err.Error())
	}

	if ch, err := tryD3DKMT(ctx, every, logger); err == nil {
		logger.Info("using D3DKMT for GPU monitoring")
		return ch, nil
	} else {
		logger.Debugf("D3DKMT: %s", err.Error())
	}

	return nil, ErrNoGpuTool
}

// nvidiaSmiProbeTimeout bounds the wait for nvidia-smi's first parseable sample.
// A working nvidia-smi emits one immediately, and the common failure below exits
// on its own, so this only fires if the process starts and then hangs.
const nvidiaSmiProbeTimeout = 10 * time.Second

// tryNvidiaSmiWindows starts nvidia-smi in loop mode on Windows and returns
// a channel receiving GPU stat snapshots. Returns ErrNoGpuTool if nvidia-smi
// is not available, or an error if it starts but never produces a parseable
// sample.
//
// Finding the binary is not proof that it works. A stale nvidia-smi.exe outlives
// the card that installed it -- e.g. left in C:\Windows\System32 after a swap to
// an AMD GPU. It then starts cleanly, writes "NVIDIA-SMI has failed because it
// couldn't communicate with the NVIDIA driver" to stdout, and exits 0, so both
// LookPath and Start succeed. Reporting success on that basis shadows the
// vendor-neutral D3DKMT fallback in getGpuStats and leaves the host with no GPU
// monitoring at all, so require one parseable sample before claiming support.
func tryNvidiaSmiWindows(ctx context.Context, every time.Duration, logger *logmon.Monitor) (chan []GpuStat, error) {
	if _, err := exec.LookPath("nvidia-smi"); err != nil {
		return nil, ErrNoGpuTool
	}

	sec := int(every.Seconds())
	if sec < 1 {
		sec = 1
	}

	cmd := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=index,name,uuid,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw",
		"--format=csv,noheader,nounits",
		"--loop", fmt.Sprintf("%d", sec),
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("nvidia-smi stdout pipe failed: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("nvidia-smi start failed: %w", err)
	}

	ch := make(chan []GpuStat, 1)

	// Buffered so the reader never blocks reporting the probe result, including
	// when this function has already timed out and stopped listening.
	probed := make(chan bool, 1)

	go func() {
		defer close(ch)

		sawStat := false
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}

			stat := ParseNvidiaSmiLine(line)
			if stat == nil {
				logger.Debugf("nvidia-smi: ignoring unparseable output: %s", line)
				continue
			}

			if !sawStat {
				sawStat = true
				probed <- true
			}

			select {
			case ch <- []GpuStat{*stat}:
			default:
			}
		}
		cmd.Wait()

		if !sawStat {
			probed <- false
		}
	}()

	select {
	case ok := <-probed:
		if !ok {
			// nvidia-smi already exited on its own; nothing to kill.
			return nil, fmt.Errorf("nvidia-smi produced no parseable GPU stats")
		}
	case <-time.After(nvidiaSmiProbeTimeout):
		cmd.Process.Kill()
		return nil, fmt.Errorf("nvidia-smi produced no parseable GPU stats within %s", nvidiaSmiProbeTimeout)
	case <-ctx.Done():
		cmd.Process.Kill()
		return nil, ctx.Err()
	}

	return ch, nil
}

func readSysStats() (SysStat, error) {
	cpuPcts, err := cpu.Percent(0, true)
	if err != nil {
		return SysStat{}, err
	}

	vmStat, err := mem.VirtualMemory()
	if err != nil {
		return SysStat{}, err
	}

	const toMB = 1024 * 1024

	netIO := make([]NetIOStat, 0)
	if ioCounters, err := net.IOCounters(true); err == nil {
		for _, ioc := range ioCounters {
			netIO = append(netIO, NetIOStat{
				Name:      ioc.Name,
				BytesRecv: ioc.BytesRecv,
				BytesSent: ioc.BytesSent,
			})
		}
	}

	return SysStat{
		Timestamp:      time.Now(),
		CpuUtilPerCore: cpuPcts,
		MemTotalMB:     int(vmStat.Total / toMB),
		MemUsedMB:      int(vmStat.Used / toMB),
		MemFreeMB:      int(vmStat.Free / toMB),
		NetIO:          netIO,
	}, nil
}
