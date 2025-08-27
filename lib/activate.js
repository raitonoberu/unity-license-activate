#!/usr/bin/env node

import { readFileSync, readdirSync, writeFile } from "fs";
import { execSync } from "child_process";

import puppeteer from "puppeteer";
import totp from "./totp";

function sleep(milliSeconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliSeconds);
  });
}

const RETRY_INTERVAL = 1000 * 30; /* Let's try every 30 seconds */
const RETRY_COUNT = 9; /* (30 * 9 = 4 mins 30 seconds), right below 5 mins  */

async function getVerificationCode(email, password, count = 0) {
  let savePath = "./code.txt";
  try {
    console.log(
      `Retrieving verification code from ${email}, attempt ${count}/${RETRY_COUNT}`,
    );
    // Make sure you install npm package `unity-verify-code`!
    const cmd = `unity-verify-code "${email}" "${password}" "${savePath}"`;
    console.log(cmd);
    execSync(cmd);
    return readFileSync(savePath, "utf8");
  } catch (err) {
    if (RETRY_COUNT !== count) {
      ++count;
      await sleep(RETRY_INTERVAL);
      return getVerificationCode(email, password, count);
    }
  }
  return -1;
}

async function start(
  email,
  password,
  alf,
  verificationCode,
  emailPassword,
  authenticatorKey,
) {
  const [browser, page] = await createBrowser();

  try {
    await login(
      page,
      email,
      password,
      verificationCode,
      emailPassword,
      authenticatorKey,
    );
    await followJump(page);
    await openLicensePage(page);
    await uploadLicense(page, alf);
    await selectLicense(page);
    await waitForFile();
  } catch (err) {
    console.log("[ERROR] " + err);

    await page.screenshot({ path: "error.png", fullPage: true });
    const html = await page.evaluate(
      () => document.querySelector("*").outerHTML,
    );
    writeFile("error.html", html, () => {});

    await browser.close();
    process.exit(1);
  }

  console.log("[INFO] Done!");
  await browser.close();
}

async function createBrowser() {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: process.cwd(),
  });

  return [browser, page];
}

async function login(
  page,
  email,
  password,
  verificationCode,
  emailPassword,
  authenticatorKey,
) {
  await startLogin(page, email, password);

  let retryAttempt = 0;
  const maxRetries = 5;
  while (
    page.url().indexOf("account/edit") === -1 &&
    retryAttempt < maxRetries + 1
  ) {
    retryAttempt++;
    if (retryAttempt > maxRetries) {
      throw "Unable to complete Sign In";
    }

    console.log(
      `[INFO] Completing Sign In, Attempt ${retryAttempt}/${maxRetries}`,
    );

    await completeLogin(
      page,
      verificationCode,
      emailPassword,
      authenticatorKey,
    );
  }
}

async function startLogin(page, email, password) {
  console.log("[INFO] Start login...");
  await page.goto("https://id.unity.com", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#new_conversations_create_session_form");

  await page.evaluate((text) => {
    document.querySelector("input[type=email]").value = text;
  }, email);
  await page.evaluate((text) => {
    document.querySelector("input[type=password]").value = text;
  }, password);

  await Promise.all([
    page.click('input[name="commit"]'),
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
  ]);
}

async function completeLogin(
  page,
  verificationCode,
  emailPassword,
  authenticatorKey,
) {
  const tfaTOTPFieldSelector =
    'input[name="conversations_tfa_required_form[verify_code]"]';
  const tfaEmailFieldSelector =
    'input[name="conversations_email_tfa_required_form[code]"]';
  const tosAcceptButtonSelector =
    'button[name="conversations_accept_updated_tos_form[accept]"]';

  // Try to work out which page we're on
  if (await page.$(tosAcceptButtonSelector)) {
    // If updated ToS are displayed
    console.log('[INFO] Accepting "Terms of service"...');

    // Accept ToS
    await Promise.all([
      page.waitForTimeout(1000),
      page.click(tosAcceptButtonSelector),
    ]);
  } else if (await page.$(tfaEmailFieldSelector)) {
    // If Email Two Factor Authentication form is displayed
    console.log("[INFO] 2FA (Email)");

    // Populate form with generated TOTP
    const verificationCodeFinal =
      verificationCode ||
      (await getVerificationCode(email, emailPassword || password));
    await page.evaluate(
      (field, text) => {
        document.querySelector(field).value = text;
      },
      tfaEmailFieldSelector,
      verificationCodeFinal,
    );

    // Submit form
    await Promise.all([
      page.click('input[name="commit"]'),
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    ]);
  } else if (await page.$(tfaTOTPFieldSelector)) {
    // If TOTP Two Factor Authentication form is displayed
    console.log("[INFO] 2FA (Authenticator App)");

    // Verify Authenticator Key was provided
    if (authenticatorKey) {
      // Populate form with generated TOTP
      const verificationCodeFinal = verificationCode || totp(authenticatorKey);
      await page.evaluate(
        (field, text) => {
          document.querySelector(field).value = text;
        },
        tfaTOTPFieldSelector,
        verificationCodeFinal,
      );

      // Submit form
      await Promise.all([
        page.click('input[type="submit"]'),
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      ]);
    } else {
      throw "2FA Required, but no authenticatorKey was provided";
    }
  } else if (await page.$("#alert-tfa-expired")) {
    console.log(
      "[INFO] Two Factor Authentication code has expired, reloading the page...",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
  }
}

async function openLicensePage(page) {
  console.log("[INFO] Navigating to https://license.unity3d.com/manual");
  await page.goto("https://license.unity3d.com/manual", {
    waitUntil: "domcontentloaded",
  });

  console.log("[INFO] Waiting for expected page reload.. hehe");
  try {
    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 5000 });
  } catch {
    console.log("[WARN] No redirecion in 5 seconds? Come and fix me, daddy!");
  }

  await page.waitForSelector('input[name="licenseFile"]');
}

async function followJump(page) {
  const needFollowJump = await page.$(".g6.connect-scan-group");
  if (needFollowJump) {
    console.log('[INFO] "Follow" action required...');

    let loginBtn = await page.$('a[rel="nofollow"]');
    loginBtn.click();

    await page.waitForNavigation({ waitUntil: "load" });

    await page.waitForSelector(".g12.phone-login-box.clear.p20");

    const emailLogin = await page.$('a[data-event="toMailLogin"]');
    const aBox = await emailLogin.boundingBox();

    await page.mouse.move(aBox.x + 100, aBox.y + 25);
    await page.mouse.down();
    await page.mouse.up();
  }
}

async function uploadLicense(page, alf) {
  const licenseFieldSelector = 'input[name="licenseFile"]';

  console.log("[INFO] Drag license file...");
  await page.waitForSelector(licenseFieldSelector);
  const input = await page.$(licenseFieldSelector);

  console.log("[INFO] Uploading alf file...");
  await input.uploadFile(alf);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click('input[name="commit"]'),
  ]);
}

async function selectLicense(page) {
  console.log("[INFO] Selecting license type...");

  const selectedTypePersonal = 'input[id="type_personal"][value="personal"]';
  await page.waitForSelector(selectedTypePersonal);
  await page.evaluate(
    (s) => document.querySelector(s).click(),
    selectedTypePersonal,
  );

  console.log("[INFO] Selecting license capacity...");

  const selectedPersonalCapacity =
    'input[id="option3"][name="personal_capacity"]';
  await page.evaluate(
    (s) => document.querySelector(s).click(),
    selectedPersonalCapacity,
  );

  const nextButton = 'input[class="btn mb10"]';
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.evaluate((s) => document.querySelector(s).click(), nextButton),
  ]);

  await page.click('input[name="commit"]');
}

async function waitForFile() {
  const downloadPath = process.cwd();
  console.log(`[INFO] Saving ulf file to ${downloadPath}...`);
  await (async () => {
    let ulf;
    do {
      for (const file of readdirSync(downloadPath)) {
        ulf |= file.endsWith(".ulf");
      }
      await sleep(1000);
    } while (!ulf);
  })();
}

export { start };
