package com.personal.round.protocol;

public final class ProtocolValidationException extends RuntimeException {

	public ProtocolValidationException(String path, String reason) {
		super(path + ": " + reason);
	}
}
