import os
from dotenv import load_dotenv
from hindsight_client import Hindsight

load_dotenv()

client = Hindsight(
    base_url=os.getenv("HINDSIGHT_BASE_URL"),
    api_key=os.getenv("HINDSIGHT_API_KEY")
)

BANK_ID = "deployguard"

# Store one past deployment failure
client.retain(
    bank_id=BANK_ID,
    content="""
    Deployment DEP-104 for the Payments API failed in production.
    The Redis timeout was changed from 5 seconds to 2 seconds.
    After deployment, payment requests experienced significant timeouts
    and API latency increased.
    The deployment was rolled back.
    Root cause: the Redis timeout configuration was too aggressive.
    Resolution: restore the Redis timeout to 5 seconds.
    """
)

print("Memory stored successfully.")

# Ask Hindsight to find it
result = client.recall(
    bank_id=BANK_ID,
    query="What happened when the Redis timeout was changed in the Payments API?"
)

print("\nRECALLED MEMORIES:")
for memory in result.results:
    print("-", memory.text)

client.close()