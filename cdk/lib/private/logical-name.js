"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultLogicalName = defaultLogicalName;
const aws_cdk_lib_1 = require("aws-cdk-lib");
/**
 * Convert a construct id to a contract logical-name segment.
 *
 * Logical segments use `[a-z0-9]+(-[a-z0-9]+)*`; a construct id is the
 * consumer's declaration site, so it is a stable default when the consumer does
 * not pass an explicit logical name.
 */
function defaultLogicalName(scope) {
    const id = scope.node.id;
    if (aws_cdk_lib_1.Token.isUnresolved(id)) {
        throw new Error(`AppTheory cannot derive a logical name from the token-valued construct id ${JSON.stringify(id)}; pass an explicit logicalName`);
    }
    const kebab = id
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();
    if (!kebab) {
        throw new Error(`AppTheory cannot derive a logical name from the construct id ${JSON.stringify(id)}; pass an explicit logicalName`);
    }
    return kebab;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9naWNhbC1uYW1lLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9naWNhbC1uYW1lLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBVUEsZ0RBaUJDO0FBM0JELDZDQUFvQztBQUdwQzs7Ozs7O0dBTUc7QUFDSCxTQUFnQixrQkFBa0IsQ0FBQyxLQUFnQjtJQUNqRCxNQUFNLEVBQUUsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztJQUN6QixJQUFJLG1CQUFLLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUM7UUFDM0IsTUFBTSxJQUFJLEtBQUssQ0FDYiw2RUFBNkUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsZ0NBQWdDLENBQ2hJLENBQUM7SUFDSixDQUFDO0lBQ0QsTUFBTSxLQUFLLEdBQUcsRUFBRTtTQUNiLE9BQU8sQ0FBQyxvQkFBb0IsRUFBRSxPQUFPLENBQUM7U0FDdEMsT0FBTyxDQUFDLGdCQUFnQixFQUFFLEdBQUcsQ0FBQztTQUM5QixPQUFPLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQztTQUNuQixPQUFPLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQztTQUNyQixXQUFXLEVBQUUsQ0FBQztJQUNqQixJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDWCxNQUFNLElBQUksS0FBSyxDQUFDLGdFQUFnRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQyxnQ0FBZ0MsQ0FBQyxDQUFDO0lBQ3RJLENBQUM7SUFDRCxPQUFPLEtBQUssQ0FBQztBQUNmLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHR5cGUgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG4vKipcbiAqIENvbnZlcnQgYSBjb25zdHJ1Y3QgaWQgdG8gYSBjb250cmFjdCBsb2dpY2FsLW5hbWUgc2VnbWVudC5cbiAqXG4gKiBMb2dpY2FsIHNlZ21lbnRzIHVzZSBgW2EtejAtOV0rKC1bYS16MC05XSspKmA7IGEgY29uc3RydWN0IGlkIGlzIHRoZVxuICogY29uc3VtZXIncyBkZWNsYXJhdGlvbiBzaXRlLCBzbyBpdCBpcyBhIHN0YWJsZSBkZWZhdWx0IHdoZW4gdGhlIGNvbnN1bWVyIGRvZXNcbiAqIG5vdCBwYXNzIGFuIGV4cGxpY2l0IGxvZ2ljYWwgbmFtZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRMb2dpY2FsTmFtZShzY29wZTogQ29uc3RydWN0KTogc3RyaW5nIHtcbiAgY29uc3QgaWQgPSBzY29wZS5ub2RlLmlkO1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKGlkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnkgY2Fubm90IGRlcml2ZSBhIGxvZ2ljYWwgbmFtZSBmcm9tIHRoZSB0b2tlbi12YWx1ZWQgY29uc3RydWN0IGlkICR7SlNPTi5zdHJpbmdpZnkoaWQpfTsgcGFzcyBhbiBleHBsaWNpdCBsb2dpY2FsTmFtZWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBrZWJhYiA9IGlkXG4gICAgLnJlcGxhY2UoLyhbYS16MC05XSkoW0EtWl0pL2csIFwiJDEtJDJcIilcbiAgICAucmVwbGFjZSgvW15BLVphLXowLTldKy9nLCBcIi1cIilcbiAgICAucmVwbGFjZSgvLSsvZywgXCItXCIpXG4gICAgLnJlcGxhY2UoL14tfC0kL2csIFwiXCIpXG4gICAgLnRvTG93ZXJDYXNlKCk7XG4gIGlmICgha2ViYWIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeSBjYW5ub3QgZGVyaXZlIGEgbG9naWNhbCBuYW1lIGZyb20gdGhlIGNvbnN0cnVjdCBpZCAke0pTT04uc3RyaW5naWZ5KGlkKX07IHBhc3MgYW4gZXhwbGljaXQgbG9naWNhbE5hbWVgKTtcbiAgfVxuICByZXR1cm4ga2ViYWI7XG59XG4iXX0=