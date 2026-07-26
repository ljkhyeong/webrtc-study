package com.personal.round.protocol;

public class ProtocolValidationException extends RuntimeException {

	private final String path;

	public ProtocolValidationException(String path, String reason) {
		super(path + ": " + reason);
		this.path = path;
	}

	public String getPath() {
		return path;
	}
}
