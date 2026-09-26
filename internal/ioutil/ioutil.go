package ioutil

import (
	"bytes"
	"io"
	"sync"
	"sync/atomic"
)

// LimitWriter is a writer that limits the number of bytes written to it.
type LimitWriter struct {
	W io.Writer
	N int // bytes remaining that can be written
	D int // bytes dropped so far
}

func (l *LimitWriter) Write(p []byte) (rnw int, err error) {
	rnw = len(p)
	if l.N <= 0 {
		l.D += len(p)
		return
	}
	if len(p) > l.N {
		l.D += len(p) - l.N
		p = p[:l.N]
	}
	_, err = l.W.Write(p)
	l.N -= len(p)
	return
}

// LinePrefixer is a writer that prefixes each line written to it with a prefix.
type LinePrefixer struct {
	W      io.Writer
	buf    []byte
	Prefix []byte
}

func (l *LinePrefixer) Write(p []byte) (n int, err error) {
	n = len(p)
	l.buf = append(l.buf, p...)
	if !bytes.Contains(p, []byte{'\n'}) { // no newlines in p, short-circuit out
		return
	}
	bufOrig := l.buf
	for {
		i := bytes.IndexByte(l.buf, '\n')
		if i < 0 {
			break
		}
		if _, err := l.W.Write(l.Prefix); err != nil {
			return 0, err
		}
		if _, err := l.W.Write(l.buf[:i+1]); err != nil {
			return 0, err
		}
		l.buf = l.buf[i+1:]
	}
	l.buf = append(bufOrig[:0], l.buf...)
	return
}

func (l *LinePrefixer) Close() error {
	if len(l.buf) > 0 {
		if _, err := l.W.Write(l.Prefix); err != nil {
			return err
		}
		if _, err := l.W.Write(l.buf); err != nil {
			return err
		}
	}
	return nil
}

type SynchronizedWriter struct {
	Mu sync.Mutex
	W  io.Writer
}

var _ io.Writer = &SynchronizedWriter{}

func (w *SynchronizedWriter) Write(p []byte) (n int, err error) {
	w.Mu.Lock()
	defer w.Mu.Unlock()
	return w.W.Write(p)
}

type SizeTrackingWriter struct {
	size atomic.Uint64
	io.Writer
}

func (w *SizeTrackingWriter) Write(p []byte) (n int, err error) {
	n, err = w.Writer.Write(p)
	w.size.Add(uint64(n))
	return
}

// Size returns the number of bytes written to the writer.
// The value is fundamentally racy only consistent if synchronized with the writer or closed.
func (w *SizeTrackingWriter) Size() uint64 {
	return w.size.Load()
}

type SizeLimitedWriter struct {
	SizeTrackingWriter
	Limit uint64
}

var _ io.Writer = &SizeLimitedWriter{}

// Write implements io.Writer, forwarding at most Limit bytes total to the
// underlying writer and silently discarding anything beyond that.
//
// It deliberately never returns a non-nil error once the limit is reached
// (as long as the underlying writer itself doesn't error). This writer is
// used as the stdout target for commands run via exec.Cmd (see
// internal/orchestrator/tasks/taskruncommand.go). When cmd.Stdout is not an
// *os.File, the Go runtime pipes the child's stdout through an os.Pipe and
// copies it to this writer in a background goroutine; if Write returns an
// error, that goroutine stops and closes its end of the pipe. If the child
// process (e.g. restic emitting a large `diff --json` stream) is still
// writing at that point, the next write to the now-reader-less pipe kills it
// with SIGPIPE, which surfaces as "signal: broken pipe" instead of the
// command finishing normally. Discarding the overflow instead of erroring
// keeps the pipe drained so the child can run to completion; only the first
// Limit bytes of output end up stored/forwarded.
func (w *SizeLimitedWriter) Write(p []byte) (n int, err error) {
	size := w.Size()
	if size >= w.Limit {
		return len(p), nil
	}

	keep := p
	overflow := 0
	if size+uint64(len(p)) > w.Limit {
		keep = p[:w.Limit-size]
		overflow = len(p) - len(keep)
	}

	written, err := w.SizeTrackingWriter.Write(keep)
	if err != nil {
		return written, err
	}
	return written + overflow, nil
}
