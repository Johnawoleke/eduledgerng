import { it, expect } from "vitest";
import { buildStatement } from "./studentStatement";
import { generateStatementPdf } from "./generateStatementPdf";
import { encodeFeeItem } from "./feeItems";

// A leaver's statement is the case that breaks a single-page layout: six years
// of termly fees is 72 charge lines plus 54 payments. This pins that it
// paginates rather than silently writing off the bottom of page one.
it("renders a six-year statement across multiple pages", () => {
  const years=6, tpy=3, fpt=4;
  const sessions:any[]=[],terms:any[]=[],fees:any[]=[],charges:any[]=[],payments:any[]=[],enrolments:any[]=[];
  const classes=["JSS1","JSS2","JSS3","SSS1","SSS2","SSS3"];
  for(let y=0;y<years;y++){
    const sid=`sess-${y}`;
    sessions.push({id:sid,name:`${2019+y}/${2020+y}`});
    enrolments.push({session_id:sid,class:classes[y],status:y===years-1?"graduated":"promoted"});
    for(let t=1;t<=tpy;t++){
      const tid=`${sid}-t${t}`;
      terms.push({id:tid,name:`Term ${t}`,session_id:sid,term_number:t});
      for(let f=0;f<fpt;f++){
        const fid=`${y}${t}${f}`.padStart(8,"0")+"-0000-4000-8000-000000000000";
        const nm=["Tuition","Books","Transport","PTA Levy"][f], amt=[45000,5000,8000,2000][f];
        fees.push({id:fid,name:nm});
        charges.push({class_fee_id:fid,amount:amt,session_id:sid,term_id:tid});
        if(f<3) payments.push({reference:`EDU-${y}${t}${f}`,date:`${2019+y}-0${t+2}-10`,method:"Paystack",
          amount:amt,status:"success",items:[encodeFeeItem(fid,nm,amt)]});
      }
    }
  }
  const s=buildStatement({
    student:{id:"s1",student_id:"OCD-1234",name:"Okafor Chinedu Emeka",class:"SSS3",status:"graduated"},
    school:{name:"Demo High School, Ikeja"},
    enrolments,charges,payments,fees,sessions,terms,
  });
  expect(s.periods).toHaveLength(6);
  expect(s.periods[0].className).toBe("JSS1");
  expect(s.periods[5].outcome).toBe("Finished school");
  expect(s.totalCharged).toBe(6*3*(45000+5000+8000+2000));
  expect(s.totalOutstanding).toBe(6*3*2000);

  const doc=generateStatementPdf(s,false);
  const pages=doc.getNumberOfPages();
  console.log("  periods:",s.periods.length,"| charge lines:",6*3*4,"| payments:",s.payments.length,"| PDF pages:",pages);
  expect(pages).toBeGreaterThan(1);
});
