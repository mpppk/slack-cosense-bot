import { verifyCosenseAuth } from "../src/cosense-auth-verifier";

try {
	// Set the exit status only after verifyCosenseAuth has returned. In
	// particular, never call process.exit while its temporary HOME exists.
	process.exitCode = await verifyCosenseAuth(process.argv[2], process.env.COSENSE_PAT);
} catch {
	// Keep unexpected failures generic: neither the credential nor CLI output is
	// safe to print from this verifier.
	console.error("Cosense read-only authentication check could not be completed safely");
	process.exitCode = 1;
}
