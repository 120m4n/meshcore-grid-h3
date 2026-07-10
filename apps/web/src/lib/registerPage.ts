import { register, validateInviteCode } from './api.ts';
import { showToast } from './toast.ts';

let validatedInviteCode = '';

const inviteForm = document.getElementById('invite-form') as HTMLFormElement;
const inviteInput = document.getElementById('invite_code') as HTMLInputElement;
const registerForm = document.getElementById('register-form') as HTMLFormElement;

inviteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = inviteInput.value.trim();
  try {
    const { valid } = await validateInviteCode(code);
    if (!valid) throw new Error('código inválido');
    validatedInviteCode = code;
    inviteForm.hidden = true;
    registerForm.hidden = false;
  } catch (err: any) {
    showToast(err.message || 'Código de invitación inválido.', 'error');
  }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await register(
      (document.getElementById('email') as HTMLInputElement).value,
      (document.getElementById('password') as HTMLInputElement).value,
      (document.getElementById('display_name') as HTMLInputElement).value,
      validatedInviteCode,
      (document.getElementById('website') as HTMLInputElement).value
    );
    localStorage.setItem('token', res.token);
    localStorage.setItem('role', 'user');
    window.location.href = '/';
  } catch (err: any) {
    showToast(err.message || 'No se pudo crear la cuenta.', 'error');
  }
});
