package com.personal.round.protocol;

public class ProtocolValidationException extends RuntimeException {

	static final int MAX_PUBLIC_MESSAGE_LENGTH = 1_024;

	private final String path;

	public ProtocolValidationException(String path, String reason) {
		super(publicMessage(path, reason));
		this.path = path;
	}

	public String getPath() {
		return path;
	}

	private static String publicMessage(String path, String reason) {
		String message = path + ": " + reason;
		if (message.length() <= MAX_PUBLIC_MESSAGE_LENGTH) {
			return message;
		}
		return message.substring(0, MAX_PUBLIC_MESSAGE_LENGTH - 1) + "…";
	}
}
