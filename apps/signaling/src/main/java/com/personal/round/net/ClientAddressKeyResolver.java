package com.personal.round.net;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.UnknownHostException;
import java.util.Arrays;
import org.springframework.stereotype.Component;

/**
 * Produces one abuse-control key from the effective remote address.
 *
 * <p>IPv4 clients retain their full address. IPv6 clients share one key per /64 so rotating
 * interface identifiers cannot reset connection, signaling-frame, or TURN issuance limits.
 * Non-numeric and malformed values fail closed into one shared unknown-client bucket without
 * triggering DNS resolution.
 */
@Component
public final class ClientAddressKeyResolver {

	static final String UNKNOWN_CLIENT = "<unknown>";

	public String resolve(InetSocketAddress remoteAddress) {
		if (remoteAddress == null) {
			return UNKNOWN_CLIENT;
		}
		InetAddress resolved = remoteAddress.getAddress();
		if (resolved != null) {
			return resolve(resolved);
		}
		return resolve(remoteAddress.getHostString());
	}

	public String resolve(String remoteAddress) {
		if (remoteAddress == null) {
			return UNKNOWN_CLIENT;
		}
		String candidate = remoteAddress.trim();
		if (candidate.length() > 1 && candidate.startsWith("[") && candidate.endsWith("]")) {
			candidate = candidate.substring(1, candidate.length() - 1);
		}
		int zoneSeparator = candidate.indexOf('%');
		if (zoneSeparator >= 0) {
			candidate = candidate.substring(0, zoneSeparator);
		}
		if (candidate.isEmpty()) {
			return UNKNOWN_CLIENT;
		}

		byte[] ipv4 = parseIpv4(candidate);
		if (ipv4 != null) {
			return key(ipv4);
		}
		if (!candidate.contains(":") || !candidate.matches("[0-9A-Fa-f:.]+")) {
			return UNKNOWN_CLIENT;
		}
		try {
			return resolve(InetAddress.getByName(candidate));
		}
		catch (UnknownHostException ignored) {
			return UNKNOWN_CLIENT;
		}
	}

	private String resolve(InetAddress address) {
		return key(address.getAddress());
	}

	private static String key(byte[] address) {
		if (address.length == 4) {
			return "ipv4:" + unsigned(address[0])
					+ "." + unsigned(address[1])
					+ "." + unsigned(address[2])
					+ "." + unsigned(address[3]);
		}
		if (address.length != 16) {
			return UNKNOWN_CLIENT;
		}

		byte[] prefix = Arrays.copyOf(address, address.length);
		Arrays.fill(prefix, 8, prefix.length, (byte) 0);
		try {
			return "ipv6:" + InetAddress.getByAddress(prefix).getHostAddress() + "/64";
		}
		catch (UnknownHostException impossible) {
			throw new IllegalStateException("A 16-byte IPv6 prefix must be valid", impossible);
		}
	}

	private static byte[] parseIpv4(String candidate) {
		String[] octets = candidate.split("\\.", -1);
		if (octets.length != 4) {
			return null;
		}
		byte[] address = new byte[4];
		for (int index = 0; index < octets.length; index++) {
			String octet = octets[index];
			if (octet.isEmpty() || octet.length() > 3) {
				return null;
			}
			int value = 0;
			for (int characterIndex = 0; characterIndex < octet.length(); characterIndex++) {
				char character = octet.charAt(characterIndex);
				if (character < '0' || character > '9') {
					return null;
				}
				value = value * 10 + character - '0';
			}
			if (value > 255) {
				return null;
			}
			address[index] = (byte) value;
		}
		return address;
	}

	private static int unsigned(byte value) {
		return Byte.toUnsignedInt(value);
	}
}
