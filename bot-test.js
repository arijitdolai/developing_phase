const puppeteer = require('puppeteer');

async function runBot() {
    // Launch browser - headless: false so you can watch the bot work
    const browser = await puppeteer.launch({ 
        headless: false,
        args: ['--window-size=1280,800'] 
    });
    const page = await browser.newPage();
    
    // REPLACE with your local or hosted URL
    const targetUrl = 'http://localhost:3000'; 
    await page.goto(targetUrl);

    console.log("--- BOT STARTED: Running Infinite Interaction Cycle ---");

    // helper for linear movement
    async function botMove(targetX, targetY) {
        // Puppeteer's mouse move is perfectly linear by default
        await page.mouse.move(targetX, targetY, { steps: 50 }); 
    }

    while (true) {
        try {
            console.log("Starting new interaction wave...");

            // 1. Random Cursor Movement (Simulating "Scanning" the page)
            await botMove(Math.random() * 800, Math.random() * 600);
            await new Promise(r => setTimeout(r, 500));

            // 2. Typing into an Input field
            // Replace '#username' with your actual input ID
            const inputExists = await page.$('input');
            if (inputExists) {
                await botMove(200, 200); // Move to general area
                await page.click('input'); 
                await page.type('input', 'Bot_Attack_Sequence_Active', { delay: 50 });
                console.log("Typed into input field.");
            }

            // 3. Clicking a Button
            // Replace 'button' with your actual button ID/Class
            const buttonExists = await page.$('button');
            if (buttonExists) {
                await botMove(400, 400); // Move toward button
                await page.click('button');
                console.log("Clicked a button.");
            }

            // 4. Clicking a URL/Link
            const linkExists = await page.$('a');
            if (linkExists) {
                // We just hover/click the first link found
                await page.click('a');
                console.log("Navigated via Link.");
                await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
                // Go back to the main page to keep the loop going
                await page.goto(targetUrl);
            }

            // Wait 2 seconds before repeating to allow backend to process
            console.log("Wave complete. Waiting for next cycle...");
            await new Promise(r => setTimeout(r, 2000));

        } catch (error) {
            console.log("Interaction failed or element not found, retrying loop...", error.message);
            await page.goto(targetUrl); // Refresh if it gets stuck
        }
    }
}

runBot().catch(err => console.error("Fatal Bot Error:", err));