"""Hand-written. The generator never touches this directory.

Each file here exists because of something a generated client cannot know: that
two 429s mean opposite things, that an event stream is not JSON, that
``completed`` does not mean the artifacts are fetchable, and that a webhook
signature covers the raw bytes.
"""
