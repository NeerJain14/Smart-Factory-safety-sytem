const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

/**
 * Send worker approval request email to the factory Admin.
 * Contains approve/reject tokenized links.
 */
async function sendWorkerApprovalEmail(adminEmail, workerName, workerEmail, approveUrl, rejectUrl) {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            body { margin:0; padding:0; background:#0a0e14; font-family:'Segoe UI',Arial,sans-serif; color:#c5cdd8; }
            .container { max-width:520px; margin:30px auto; background:#111820; border:1px solid #1e2a38; border-radius:6px; overflow:hidden; }
            .header { background:linear-gradient(135deg,#0d1520,#142030); padding:28px 30px; border-bottom:1px solid #1e2a38; }
            .header h1 { margin:0; font-size:16px; letter-spacing:2px; color:#00f0ff; font-weight:700; }
            .header p { margin:6px 0 0; font-size:11px; color:#5a6a7a; letter-spacing:1px; }
            .body { padding:28px 30px; }
            .body p { font-size:14px; line-height:1.7; margin:0 0 14px; }
            .detail-box { background:#0a0e14; border:1px solid #1e2a38; border-radius:4px; padding:16px 20px; margin:20px 0; }
            .detail-row { display:flex; justify-content:space-between; padding:6px 0; font-size:13px; }
            .detail-label { color:#5a6a7a; }
            .detail-value { color:#e0e8f0; font-weight:600; }
            .btn-row { display:flex; gap:12px; margin:24px 0 8px; }
            .btn { display:inline-block; padding:12px 28px; border-radius:4px; text-decoration:none; font-weight:700; font-size:13px; letter-spacing:1px; text-align:center; flex:1; }
            .btn-approve { background:#00e676; color:#0a0e14; }
            .btn-reject { background:transparent; border:1px solid #ff1744; color:#ff1744; }
            .footer { padding:18px 30px; border-top:1px solid #1e2a38; text-align:center; font-size:10px; color:#3a4a5a; letter-spacing:1px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>SMART FACTORY SAFETY SYSTEM</h1>
                <p>WORKER ACCESS REQUEST</p>
            </div>
            <div class="body">
                <p>A new worker has requested access to your factory. Review the details below and approve or reject their request.</p>
                <div class="detail-box">
                    <div class="detail-row"><span class="detail-label">NAME</span><span class="detail-value">${workerName}</span></div>
                    <div class="detail-row"><span class="detail-label">EMAIL</span><span class="detail-value">${workerEmail}</span></div>
                </div>
                <div class="btn-row">
                    <a href="${approveUrl}" class="btn btn-approve">✓ APPROVE</a>
                    <a href="${rejectUrl}" class="btn btn-reject">✗ REJECT</a>
                </div>
            </div>
            <div class="footer">
                SMART FACTORY SAFETY SYSTEM — AUTOMATED NOTIFICATION
            </div>
        </div>
    </body>
    </html>`;

    const mailOptions = {
        from: `"Smart Factory System" <${process.env.SMTP_USER}>`,
        to: adminEmail,
        subject: `[SFSS] Worker Access Request — ${workerName}`,
        html
    };

    return transporter.sendMail(mailOptions);
}

module.exports = { sendWorkerApprovalEmail };
