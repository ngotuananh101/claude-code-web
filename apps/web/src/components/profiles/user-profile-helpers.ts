/**
 * Validate username with the following rules:
 * - Trimmed length must be 2-32 characters
 * - Must match regex /^[a-zA-Z0-9_.-]{2,32}$/
 */
export function validateUsername(username: string): {
  valid: boolean;
  error?: string;
  errorKey?: string;
} {
  const trimmed = username.trim();

  if (trimmed.length < 2) {
    return {
      valid: false,
      error: "Username must be at least 2 characters.",
      errorKey: "user.usernameTooShort",
    };
  }

  if (trimmed.length > 32) {
    return {
      valid: false,
      error: "Username must be at most 32 characters.",
      errorKey: "user.usernameTooLong",
    };
  }

  const usernameRegex = /^[a-zA-Z0-9_.-]+$/;
  if (!usernameRegex.test(trimmed)) {
    return {
      valid: false,
      error: "Username can only contain letters, numbers, dots, underscores, and hyphens.",
      errorKey: "user.usernameInvalidChars",
    };
  }

  return { valid: true };
}

/**
 * Validate password change fields:
 * - If all three are empty, valid (password not being changed)
 * - If any is entered: current required, next min 8 chars, next === confirm
 */
export function validatePasswordChange(
  current: string,
  next: string,
  confirm: string,
): { valid: boolean; error?: string; errorKey?: string } {
  const trimmedCurrent = current.trim();
  const trimmedNext = next.trim();
  const trimmedConfirm = confirm.trim();

  // If all fields are empty, password is not being changed - valid
  if (!trimmedCurrent && !trimmedNext && !trimmedConfirm) {
    return { valid: true };
  }

  // If any field is entered, current password is required
  if (!trimmedCurrent) {
    return {
      valid: false,
      error: "Current password is required.",
      errorKey: "user.currentPasswordRequired",
    };
  }

  // Next password must be at least 8 characters
  if (trimmedNext.length < 8) {
    return {
      valid: false,
      error: "New password must be at least 8 characters.",
      errorKey: "user.newPasswordTooShort",
    };
  }

  // Next and confirm must match
  if (trimmedNext !== trimmedConfirm) {
    return {
      valid: false,
      error: "New passwords do not match.",
      errorKey: "user.newPasswordsDoNotMatch",
    };
  }

  return { valid: true };
}

/**
 * Downscale avatar image using HTML5 Canvas.
 * - Creates a square canvas, center-crops and scales to maxDim x maxDim
 * - Returns JPEG base64 with 0.85 quality (guaranteed < 100KB)
 */
export async function downscaleAvatarImage(file: File, maxDim = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const arrayBuffer = event.target?.result as ArrayBuffer;
      if (!arrayBuffer) {
        reject(new Error("Failed to read file"));
        return;
      }

      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");

          if (!ctx) {
            reject(new Error("Failed to get canvas context"));
            return;
          }

          // Calculate dimensions for center-crop square
          const size = Math.min(img.width, img.height);
          const startX = (img.width - size) / 2;
          const startY = (img.height - size) / 2;

          // Set canvas size to maxDim
          canvas.width = maxDim;
          canvas.height = maxDim;

          // Draw cropped and scaled image
          ctx.drawImage(img, startX, startY, size, size, 0, 0, maxDim, maxDim);

          // Export as JPEG with 0.85 quality
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          resolve(dataUrl);
        } catch (err) {
          reject(err);
        }
      };

      img.onerror = () => {
        reject(new Error("Failed to load image"));
      };

      img.src = URL.createObjectURL(file);
    };

    reader.onerror = () => {
      reject(new Error("Failed to read file"));
    };

    reader.readAsArrayBuffer(file);
  });
}
