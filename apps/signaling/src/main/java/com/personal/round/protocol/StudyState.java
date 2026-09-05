package com.personal.round.protocol;

public record StudyState(long revision, String topic, String mode, int durationSeconds, long remainingMs, boolean running) { }
