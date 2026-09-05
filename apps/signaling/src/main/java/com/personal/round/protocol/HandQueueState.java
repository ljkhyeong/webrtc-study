package com.personal.round.protocol;

import java.util.List;

public record HandQueueState(long revision, List<String> peerIds, List<String> supportedPeerIds) { }
