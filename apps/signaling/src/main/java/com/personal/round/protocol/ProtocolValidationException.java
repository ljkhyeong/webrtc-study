package com.personal.round.protocol;

public class ProtocolValidationException extends RuntimeException {

	public ProtocolValidationException(String path, String reason) {
		super(path + ": " + reason);
	}
}
