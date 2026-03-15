const puppeteer = require('puppeteer');

async function runBot() {
    const browser = await puppeteer.launch({ 
        headless: false, // Set to true if you don't want to see the window
        defaultViewport: { width: 1280, height: 800 }
    });
    const page = await browser.newPage();
    
    // 1. SET YOUR URL HERE
    const targetUrl = 'http://localhost:3000'; 
    await page.goto(targetUrl);

    console.log("--- BOT STARTED: Running with Anti-Refresh Protection ---");

    // 2. INJECT PROTECTION: Prevents the page from refreshing on click
    // This ensures your score doesn't reset to 0 during the test
    await page.evaluateOnNewDocument(() => {
        window.addEventListener('click', (e) => {
            const target = e.target.closest('a, button, input[type="submit"]');
            if (target) {
                console.log("Bot clicked: Refresh blocked to preserve ML score.");
                e.preventDefault(); 
            }
        }, true);
    });

    // Helper: Linear movement logic
    async function botMove(x, y) {
        await page.mouse.move(x, y, { steps: 50 }); 
    }

    while (true) {
        try {
            console.log("\n--- Starting Interaction Cycle ---");

            // STEP A: Randomized Mouse Scanning
            // Moves the mouse to random coordinates to generate "Path Data"
            for(let i=0; i<3; i++) {
                await botMove(Math.random() * 1000, Math.random() * 800);
                await new Promise(r => setTimeout(r, 300));
            }

            // STEP B: Typing Simulation
            const inputField = await page.$('input');
            if (inputField) {
                const box = await inputField.boundingBox();
                await botMove(box.x + 5, box.y + 5);
                await page.click('input');
                // Typing with a robotic, perfectly consistent 50ms delay
                await page.type('input', 'Automated_Sequence_Test_01', { delay: 50 });
                console.log("Action: Typed into field.");
            }

            // STEP C: Button Interaction (With Sync Delay)
            const button = await page.$('button');
            if (button) {
                const box = await button.boundingBox();
                await botMove(box.x + (box.width/2), box.y + (box.height/2));
                
                // CRITICAL: Hover first so the JS Hook sends the path data
                await page.hover('button'); 
                console.log("Action: Hovering button (Syncing data...)");
                await new Promise(r => setTimeout(r, 1500)); // 1.5s wait for your backend
                
                await page.click('button');
                console.log("Action: Clicked button.");
            }

            // STEP D: Link Interaction
            const link = await page.$('a');
            if (link) {
                const box = await link.boundingBox();
                await botMove(box.x + 2, box.y + 2);
                await page.hover('a');
                await new Promise(r => setTimeout(r, 1000));
                await page.click('a');
                console.log("Action: Clicked Link.");
            }

            console.log("Cycle Complete. Restarting in 2 seconds...");
            await new Promise(r => setTimeout(r, 2000));

        } catch (error) {
            console.log("Loop Error (likely element missing), retrying...", error.message);
            await page.goto(targetUrl).catch(() => {}); 
        }
    }
}

runBot().catch(err => console.error("Fatal Error:", err));